# План 1d2: хост — люди и устройства: контрагенты, линии, операторы с PIN и бейджами, устройства и коды подключения — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост ведёт справочники людей и устройств для офиса и отдаёт станциям то, что им нужно для входа оператора. Администратор заводит контрагентов, линии, операторов с хешами PIN и бейджей, переименовывает и отзывает устройства; технолог читает контрагентов и линии. Лента изменений получает операторов и бейджи, и каждое изменение, закрывающее доступ, идёт по ней надгробием, а не флагом. «Новый код» гасит прежний код подключения. Экраны офиса и копии на станции — планы 1d3 и 1d4; этот план готовит им API, данные и договор ленты.

**Architecture:**

- `host/migrations/0007_people.sql` — таблицы `counterparties`, `operators`, `operator_badges` с индексами по `rev` и частичным уникальным индексом бейджа.
- `host/src/feed.rs` — общий помощник писателей ленты: `remove` пишет надгробие, `restore` удаляет надгробие ключа, который вернулся в ленту.
- `host/src/routes/changes.rs` — сущности `operators` (только активные) и `operator_badges` (только неотозванные); поток изменений заканчивается, когда его устройство отозвали.
- Новые модули маршрутов `counterparties.rs`, `lines.rs`, `operators.rs` (операторы, бейджи, соль); `devices.rs` получает изменение и отзыв, `pairing.rs` — `replaces`.
- `host/src/validate.rs` — общие проверки реквизитов (`company`), табельного номера, должности, подписи бейджа, имени устройства и строк PHC; `secrets::parse_phc` — потолок итераций.
- `proto` — типы запросов, ответов и записей ленты с фикстурами; помощник `nullable` отличает «поле не прислано» от `null`.
- `AppState::revocations` — `watch` со счётчиком отзывов: разбуженный отзывом поток перечитывает своё устройство.

**Tech Stack:** Rust — axum 0.8.9 (SSE, `OptionalFromRequest`), sqlx 0.8.6 (SQLite), tokio 1.53.1 (`sync::watch`), serde, aws-lc-rs 1.18.1, base64 0.22.1; тесты роутера — `tower::ServiceExt::oneshot` и `MockConnectInfo`. TypeScript — только схема Zod `pairingCodeSchema` (zod 4.4.3) и Vitest 4.

**Спецификации:**

- Решения контроллера — `.superpowers/sdd/1d2-design.md`; решения владельца от 2026-09-27 в нём обязательны.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §4.3 — схема, §4.4 — лента, §4.5 — протокол, §4.6 — ошибки, §4.7 — подключение, §4.8 — роли, §4.9 — журнал, §4.10 — журналы процесса; этот план — хостовая часть строки 1d раздела 8.
- Планы 1b1 и 1c1 и их разделы «Отклонения при исполнении»: каркас хоста, `begin_write`, `commit_with_revision`, словарь журнала, коды и лента.

## Global Constraints

**Решения владельца и контроллера (обязательные)**

1. «Новый код» гасит код, который заменяет (владелец, 2026-09-27).
   - `POST /v1/office/pairing-codes` принимает необязательное тело `{ "replaces": "<id кода>" }`; без заголовка `Content-Type` тела нет, и хост ведёт себя как в плане 1c1.
   - Ответ — `{ id, code, createdAt, expiresAt, payload }`.
   - Живой код (`used_at IS NULL`, `expires_at > сейчас`, `failed_attempts < 5`), созданный тем же офисным пользователем, истекает в той же транзакции: `expires_at` = сейчас.
   - `claim` с погашенным кодом отвечает `pairing_code_expired`, строка журнала отказа — `code_expired`. Почему не `pairing_code_invalid`: код был настоящим и перестал действовать, а не набран с ошибкой, и устройство должно сказать «код истёк, возьмите новый с экрана офиса», а не «проверьте код»; заодно погашенный код выпадает из живых, которым засчитывается неверная попытка.
   - `replaces`, который называет что-то другое (код другого пользователя, неизвестный, использованный, истёкший или исчерпавший попытки), хост пропускает и выдаёт новый код. Почему не отказ: отказ ничем не защищает, а «Новый код» сломался бы в самом частом случае — после того, как прежний код умер сам. Коды других пользователей не трогаются никогда.
   - Замену записывает строка `pairing_code.create` нового кода: `{ "expiresAt": …, "replaces": "<id>" }`; `replaces` в ней только тогда, когда код действительно погашен.
2. Изменение, закрывающее доступ, идёт по ленте надгробием, а не флагом (контроллер, итоговое ревью 1d1): вебвью читает записи через `z.object`, и незнакомое поле более нового хоста просто отбросилось бы.
   - Оператор в `GET /v1/changes`, только пока активен. Выключение пишет надгробие `('operators', id)`; повторное включение удаляет его и отдаёт запись с новой ревизией.
   - Бейдж — только пока не отозван. Отзыв пишет надгробие `('operator_badges', id)`; отозванный бейдж не возвращается, новый бейдж получает новый идентификатор.
   - Смена PIN — обновление записи с новым `pinPhc`: станция заменяет хеш, и старый PIN перестаёт работать.
   - Запись бейджа сама доступа не даёт: вход оператора на станции (план 1f) требует запись оператора с этим `operatorId`. Выключение оператора бейджи не отзывает: они остаются в ленте и снова работают, когда оператор включён.
   - Ключ, вернувшийся в ленту после надгробия, удаляет своё надгробие: лента никогда не несёт и то и другое. Делают это общие `feed::remove` и `feed::restore`, а не каждый писатель сам.

**Лента**

- Сущности и их `data`, точно:
  - `operators` — `{ "login": "0042", "name": "…", "role": "…" | null, "pinPhc": "pbkdf2$…" }`;
  - `operator_badges` — `{ "operatorId": "<uuid>", "badgePhc": "pbkdf2$…", "label": "…" | null }`.
- Порядок `(rev, entity, id, deleted DESC)`, порции и `hasMore` — как в плане 1c1. Индексы `operators_rev` и `operator_badges_rev` — в миграции 0007; у `lines` и `tombstones` они есть.
- Контрагенты, устройства и коды подключения в ленту не входят. Контрагенты всё равно берут ревизию: по ней работает `expectedRev`.

**PHC и соль бейджей**

- Строка PHC — `pbkdf2$sha256$<итерации>$<соль>$<хеш>`: каноничный стандартный base64 с выравниванием, соль 16 байт, хеш 32 байта, итерации — только цифры ASCII (`secrets::parse_phc`, формат `packages/domain/src/crypto/phc.ts`).
- Итерации: от `MIN_ITERATIONS = 10_000` до `MAX_ITERATIONS = 1_000_000` включительно. Потолок стоит в `parse_phc` и потому охватывает и пароли офиса (600 000). Почему 1 000 000: станция проверяет PIN с числом итераций из хеша, и хеш с миллиардом итераций остановил бы вход; десятикратный запас над 100 000 оставляет место поднять значение домена.
- Хеш бейджа: ровно `BADGE_ITERATIONS = 100_000` итераций и соль, равная `site.badge_salt` (ответ `GET /v1/office/badge-salt` и `badgeSalt` записи `site`). Так бейдж хеширует облако (`hashBadgeWithSalt` в `apps/api/src/lib/badge-salt.ts`: соль арендатора и `PHC_ITERATIONS`), а станция проверяет его с солью и итерациями из самого хеша (`verifyBadge`), поэтому такой хеш она принимает без изменений. Почему итерации фиксированы, а не ограничены, как у PIN: уникальный индекс сравнивает строки целиком, и та же карта с другим числом итераций прошла бы мимо него.
- Хост никогда не получает PIN и код бейджа, офис никогда не получает хеш: чтения операторов несут `hasPin` и сведения о бейджах (`BadgeInfo`). Поля с хешами и солью в `proto` — `Secret`: `Debug` их не печатает.
- В `details` журнала и в журнале процесса нет ни строк PHC, ни соли; `no_secrets_in_logs.rs` проходит путь оператора и бейджа.

**Роли** (спецификация, §4.8)

- Контрагенты и линии: `GET` — все роли, `POST` и `PUT` — администратор.
- Операторы, бейджи и соль бейджей: только администратор, чтение тоже; технолог получает `forbidden`.
- Устройства (`GET`, `PUT`, отзыв) и коды подключения: только администратор.
- Роль перечитывается на каждом запросе офиса (`OfficeContext`); каждая запись администратора перепроверяет права внутри транзакции (`require_admin_in`).

**Конкурентность**

- `PUT` контрагентов, линий и операторов несёт `expectedRev` и отвечает `stale_revision` с `details.currentRev`, если строка ушла вперёд.
- Бейдж создаётся и отзывается без `expectedRev`: это создание и отзыв, а не правка записи.
- У устройств нет `rev`: запись побеждает последней, ревизия хоста не меняется (как у `PUT /v1/device/line`).
- Запрос, который ничего не меняет, ничего не пишет: ни ревизии, ни строки, ни журнала. Повторный отзыв бейджа — 204, повторный отзыв устройства — 200 с прежней записью, а не ошибка: запрос, повторённый после потерянного ответа, не должен падать.

**Коды ошибок** (новых кодов нет)

- `validation_failed` с `details.field`: `name`, `inn`, `gln`, `gs1Prefixes` (контрагенты), `name` (линии, устройства), `login`, `name`, `role`, `pinPhc` (операторы), `badgePhc`, `label` (бейджи), `lineId` (устройства). Тело с лишним полем — `validation_failed` без `field` (`deny_unknown_fields`).
- `conflict` с `details.constraint`: `login` — табельный номер занят; `badge` — такой бейдж уже числится неотозванным у какого-то оператора; `line_name` — имя занято неархивной линией без учёта регистра.
- `not_found` — нет контрагента, линии, оператора, бейджа этого оператора, устройства; тело проверяется раньше поиска записи.
- `unauthorized` с `credential: device` — любой запрос отозванного устройства.

**Журнал действий** (§4.9, словарь `audit::actions`)

| Действие                | `target_type`    | `details`                                                                        |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `counterparty.create`   | `counterparty`   | `{ name, gln }`                                                                  |
| `counterparty.update`   | `counterparty`   | `update_details`: `name`, `inn`, `gln`, `gs1Prefixes`, `archived`                |
| `line.create`           | `line`           | `{ name }`                                                                       |
| `line.update`           | `line`           | `update_details`: `name`, `archived`                                             |
| `operator.create`       | `operator`       | `{ login, role }`                                                                |
| `operator.update`       | `operator`       | `update_details_hiding`: `name`, `role`, `active`; `pinPhc` — только в `changed` |
| `operator_badge.create` | `operator_badge` | `{ operatorId, label }`                                                          |
| `operator_badge.revoke` | `operator_badge` | `{ operatorId }`                                                                 |
| `device.update`         | `device`         | `update_details`: `name`, `lineId`                                               |
| `device.revoke`         | `device`         | `{ kind, name }`                                                                 |
| `pairing_code.create`   | `pairing_code`   | `{ expiresAt }`, с `replaces`, если код погашен                                  |

- Исполнитель — офисный пользователь (`actor_kind = office_user`, `actor_id` — его id), результат `ok`. Тесты сверяют строку целиком: `actor_kind`, `actor_id`, `action`, `target_type`, `target_id`, `result` и разобранный `details`.
- Запрос без изменений строки не пишет. Отказанная запись офиса (`validation_failed`, `forbidden`, `not_found`, `stale_revision`, `conflict`) тоже не пишет строку — как у всех писателей офиса с плана 1b1: она ничего не изменила, а строки `denied` остаются за отказами входа, смены пароля и подключения. Решение плана; если владелец захочет журнал отказов, это отдельный план для всех писателей офиса.

**Формы протокола** (фикстуры `proto/fixtures`)

- Контрагент — `CounterpartyRecord { id, name, inn: string | null, gln, gs1Prefixes: string[], archived, rev }`; `POST` — `{ name, inn?, gln, gs1Prefixes }`; `PUT …/{id}` — запись целиком `{ name, inn?, gln, gs1Prefixes, archived, expectedRev }`. Почему целиком, как профиль организации: форма правит все поля сразу, а частичному `PUT` пришлось бы отличать «`inn` не прислан» от «`inn: null` — очистить».
- Линия — `OfficeLine { id, name, archived, rev }`; `POST` — `{ name }`; `PUT …/{id}` — `{ name?, archived?, expectedRev }`.
- Оператор — `OfficeOperator { id, login, name, role: string | null, active, hasPin, badges: BadgeInfo[], rev }`, `BadgeInfo { id, label: string | null, createdAt, revokedAt: string | null }`; `POST` — `{ login, name, role?, pinPhc }`; `PUT …/{id}` — `{ name?, role?: string | null, active?, pinPhc?, expectedRev }`: `role: null` очищает, отсутствие — оставляет. Табельный номер не меняется; PIN при создании обязателен.
- Бейдж — `POST /v1/office/operators/{id}/badges` `{ badgePhc, label? }` → `BadgeInfo`; `DELETE …/badges/{badgeId}` → 204; `GET /v1/office/badge-salt` → `{ badgeSalt }`.
- Устройство — `PUT /v1/office/devices/{id}` `{ name?, lineId?: string | null }` → `DeviceRecord`; `POST …/{id}/revoke` → `DeviceRecord` с `revokedAt`.
- Код подключения — ответ `{ id, code, createdAt, expiresAt, payload }`, тело `{ replaces? }`.
- Проверки полей: имя контрагента 1–200 символов, ИНН 10 или 12 цифр либо пусто, GLN 13 цифр, не больше 10 префиксов по 4–12 цифр (как профиль организации, `validate::company`); имя линии и устройства 1–100 символов; табельный номер — 3–12 цифр ASCII, ведущие нули — часть номера; должность — до 120 символов, как должность сотрудника в облаке (`apps/api/src/modules/employees/dto.ts`), пустая — `null`; подпись бейджа — до 100 символов, пустая — `null`. Все строки обрезаются.

**Устройства**

- Отзыв ставит `revoked_at`, удаляет офисные сессии устройства в той же транзакции и после коммита поднимает `AppState::revocations`. Открытый поток, разбуженный этим счётчиком, перечитывает своё устройство и заканчивается, если его отозвали; при открытии поток подписывается на счётчик и потом ещё раз проверяет устройство. Почему счётчик в `watch`, а не рассылка идентификаторов: канал не переполняется и не теряет события, а решает база.
- Отозванное устройство остаётся в `GET /v1/office/devices` с `revokedAt`. Администратор может отозвать и своё устройство: его сессия кончится вместе с остальными.
- Линию можно назначить только станции и только существующую неархивную, иначе `validation_failed` с `field: lineId` (сама не-станция на `PUT /v1/device/line` получает `forbidden`, план 1c1); `lineId: null` снимает линию у любого устройства.
- Архивирование линии устройства не трогает: станция на архивной линии остаётся на ней (записано в «Перенесено»).

**Код и процесс**

- Новых крейтов нет: `base64`, `uuid`, `tokio::sync::watch` и `OptionalFromRequest` axum уже есть.
- Правила записей из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на транзакцию, коммит через `commit_with_revision`, пул не трогать при открытой транзакции записи, без изменений — без записи, `require_admin_in` в каждой записи администратора.
- Запросы в `proto` — `deny_unknown_fields`, ответы неизвестные поля пропускают. Каждый новый тип — с фикстурой, которую разбирает тест `proto`; схемы Zod для новых фикстур — план 1d3. Меняется только `pairingCodeSchema`: `pairing-code.json` уже читает Vitest.
- `apps/station` не меняется, оболочка (`src-tauri`) — тоже.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; он встречается в файле один раз. Правки внутри шага идут сверху вниз по файлу.
- «Заменить содержимое … целиком» — файл пишется заново, ровно как в блоке. «Create» — новый файл.
- Код в блоках уже отформатирован `cargo fmt` и prettier; расхождение при проверке значит опечатку.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента.
- Блоки импорта `use markiro_proto::{…}` в `proto/tests/fixtures.rs` меняются целиком: `cargo fmt` переливает весь список при каждом новом имени.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.
- `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD.
- `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline`. Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.
- Тесты, которые слушают 127.0.0.1, — только вне песочницы: `host/tests/hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, `changes_stream.rs` (из-за `open_streams_end_when_the_host_stops`) и все `src-tauri/tests/*.rs`. Остальные тесты хоста работают в процессе.
- `cargo test -p markiro-host` и `-p markiro-proto` не собирают оболочку. Для `cargo test --workspace` нужен `apps/standalone/dist`: сначала `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.
- Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- Текст с кириллицей через инструмент правки иногда ложится буквальными `\uXXXX`: после правки проверяйте байты (`grep -n '\\u0' <файл>` ничего не находит).

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/host/migrations/0007_people.sql, host/src/feed.rs, host/src/lib.rs          задача 1
apps/standalone/host/src/routes/changes.rs                                                   задачи 1, 6
apps/standalone/host/tests/changes.rs, proto/fixtures/changes-people.json                    задача 1
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                                    задачи 1–8
apps/standalone/host/tests/support/app.rs                                                     задача 2
apps/standalone/host/src/{validate,audit,server}.rs                                           задачи 2–8
apps/standalone/host/src/error.rs                                                             задачи 2, 7
apps/standalone/host/src/routes/mod.rs                                                        задачи 2–4
apps/standalone/host/src/routes/counterparties.rs, host/tests/counterparties.rs              задача 2
apps/standalone/proto/fixtures/counterparty-{record,create,update}.json                       задача 2
apps/standalone/host/src/routes/lines.rs, host/tests/lines.rs                                 задача 3
apps/standalone/proto/fixtures/{office-line,line-create,line-update}.json                      задача 3
apps/standalone/host/src/secrets.rs                                                           задачи 4, 5, 8
apps/standalone/host/src/routes/operators.rs                                                  задачи 4, 5
apps/standalone/host/tests/operators.rs, proto/fixtures/{office-operator,operator-create,operator-update}.json   задача 4
apps/standalone/host/tests/{badges,no_secrets_in_logs}.rs, proto/fixtures/badge-{create,salt}.json             задача 5
apps/standalone/host/src/routes/devices.rs                                                    задачи 6, 8
apps/standalone/host/tests/{devices,changes_stream}.rs, proto/fixtures/device-update.json     задача 6
apps/standalone/host/src/{pairing_code,routes/pairing}.rs, host/tests/pairing_codes.rs        задача 7
apps/standalone/proto/fixtures/pairing-code{,-request}.json                                   задача 7
apps/standalone/src/host/protocol.ts, test/devices-page.test.tsx                              задача 7
apps/standalone/host/src/{auth,routes/office_auth,routes/office_users,routes/bootstrap}.rs    задача 8
apps/standalone/host/tests/{office_admin,device_line,claim,changes_stream,office_auth}.rs    задача 8
apps/standalone/AGENTS.md                                                                     задачи 1, 2, 5–8
спецификация: §4.4 — задача 1; §4.3 — задачи 2–5; §4.5 — задачи 2–7; §4.9 — задача 2; §4.7 — задачи 6, 7
```

Миграция одна и стоит в задаче 1 вместе с договором ленты: тесты ленты пишут строки операторов и бейджей напрямую, до маршрутов задач 4 и 5. Общая поддержка тестов появляется в задаче 2 вместе с первым новым тестом маршрутов, а прежние копии её помощников переходят на неё в задаче 8. Бейджи — отдельная задача от операторов: у них своя проверка хеша, своя сущность ленты и свой отзыв.

---

### Task 1: Люди в модели хоста и в ленте — миграция 0007, `feed`, записи операторов и бейджей

Миграция создаёт все три таблицы плана: контрагентов, операторов и бейджи. Лента `GET /v1/changes` получает две сущности, `operators` и `operator_badges`, и правило надгробий: оператор в ленте, только пока активен, бейдж — только пока не отозван. Модуль `feed` — общий помощник писателей: `remove` пишет или сдвигает надгробие, `restore` удаляет надгробие ключа, который вернулся в ленту. Сейчас надгробия пишут только тесты: писателей с удалением ещё нет, поэтому помощник появляется здесь, до первого писателя (задачи 4 и 5).

Маршрутов в задаче нет: тесты ленты пишут строки напрямую, как существующие тесты `tests/changes.rs`. Индексы по `rev` новых таблиц — в той же миграции (`operators_rev`, `operator_badges_rev`); у `lines` и `tombstones` они есть с плана 1c1, у `org_profile` и `site` по одной строке.

**Files:**

- Create: `apps/standalone/host/migrations/0007_people.sql`, `apps/standalone/host/src/feed.rs`, `apps/standalone/proto/fixtures/changes-people.json`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/routes/changes.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/changes.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Change feed»), `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§4.4)

**Interfaces:**

- Consumes:
  - `db::begin_write`, `db::next_revision`, `db::commit_with_revision` — `host/src/db.rs`;
  - `FEED_KEYS`, `record(conn, key)` — `host/src/routes/changes.rs`;
  - `Secret` — `proto/src/lib.rs`;
  - `changes(app, key, query)`, `TestApp`, `pair_device`, `bootstrap` — `host/tests/changes.rs`, `host/tests/support/app.rs`.
- Produces:
  - таблицы `counterparties`, `operators`, `operator_badges` и индексы `operators_rev`, `operator_badges_active_phc`, `operator_badges_operator`, `operator_badges_rev`;
  - `pub async fn feed::remove(conn: &mut SqliteConnection, entity: &str, id: &str, rev: i64) -> Result<(), sqlx::Error>`;
  - `pub async fn feed::restore(conn: &mut SqliteConnection, entity: &str, id: &str) -> Result<(), sqlx::Error>`;
  - `entities::OPERATORS = "operators"`, `entities::OPERATOR_BADGES = "operator_badges"`;
  - `OperatorRecord { login, name, role: Option<String>, pin_phc: Secret }`, `OperatorBadgeRecord { operator_id, badge_phc: Secret, label: Option<String> }` — `proto/src/lib.rs`;
  - фикстура `proto/fixtures/changes-people.json`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/changes-people.json`:

```json
{
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "rev": 57,
  "hasMore": false,
  "items": [
    {
      "entity": "operators",
      "id": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "rev": 55,
      "deleted": false,
      "data": {
        "login": "0042",
        "name": "Анна Кузнецова",
        "role": "Упаковщик",
        "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
      }
    },
    {
      "entity": "operator_badges",
      "id": "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      "rev": 56,
      "deleted": false,
      "data": {
        "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
        "badgePhc": "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=",
        "label": null
      }
    },
    {
      "entity": "operator_badges",
      "id": "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
      "rev": 57,
      "deleted": true
    },
    {
      "entity": "operators",
      "id": "5b9d2e4f-6a1c-4d3e-8f2a-7b6c5d4e3f21",
      "rev": 57,
      "deleted": true
    }
  ]
}
```

2. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    ClaimRequest, Compatibility, DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord,
    ErrorBody, Hello, HelloEnvelope, LineRecord, LocalPairRequest, OfficeLoginRequest, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange, PasswordSet,
    SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
    ClaimRequest, Compatibility, DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord,
    ErrorBody, Hello, HelloEnvelope, LineRecord, LocalPairRequest, OfficeLoginRequest, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorRecord, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PasswordChange, PasswordSet, SiteRecord, SsccCounterUpdate, SsccState,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn the_people_feed_fixture_round_trips_without_leaking_hashes() {
    let changes: ChangesResponse = round_trip("changes-people.json");
    assert_eq!(changes.items.len(), 4);
    let operator: OperatorRecord =
        serde_json::from_value(changes.items[0].data.clone().unwrap()).unwrap();
    // The PIN hash is the one TypeScript computed for the PIN 4821.
    assert_eq!(
        operator.pin_phc.expose(),
        fixture("phc-password.json")["pinPhc"].as_str().unwrap()
    );
    let badge: OperatorBadgeRecord =
        serde_json::from_value(changes.items[1].data.clone().unwrap()).unwrap();
    assert_eq!(badge.operator_id, changes.items[0].id);
    assert_eq!(badge.label, None);
    // The badge is hashed with the site's badge salt.
    let salt = fixture("changes-response.json")["items"][2]["data"]["badgeSalt"].clone();
    assert_eq!(badge.badge_phc.expose().split('$').nth(3), salt.as_str());
    assert!(changes.items[2..]
        .iter()
        .all(|item| item.deleted && item.data.is_none()));
    let debug = format!("{operator:?} {badge:?}");
    assert!(!debug.contains("pbkdf2"), "{debug}");
}

#[test]
fn the_error_code_fixture_lists_every_code() {
```

4. В `apps/standalone/host/tests/changes.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
#[tokio::test]
async fn the_feed_needs_a_device_key_but_no_office_session() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[tokio::test]
async fn the_feed_needs_a_device_key_but_no_office_session() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_PHC: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
/// A badge verifier, stored as the office computed it.
const BADGE_PHC: &str =
    "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";

/// Insert an active operator at a new revision; returns its id and the revision.
async fn add_operator(app: &TestApp, login: &str) -> (String, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
         VALUES (?, ?, ?, NULL, ?, 1, ?)",
    )
    .bind(&id)
    .bind(login)
    .bind(format!("Оператор {login}"))
    .bind(PIN_PHC)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (id, rev)
}

/// Insert a badge of `operator_id` at a new revision; returns its id and the
/// revision, or the database's refusal.
async fn insert_badge(
    app: &TestApp,
    operator_id: &str,
    badge_phc: &str,
) -> Result<(String, i64), sqlx::Error> {
    let mut tx = markiro_host::db::begin_write(&app.state.pool).await?;
    let rev = markiro_host::db::next_revision(&mut tx).await?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
         VALUES (?, ?, ?, 'Пропуск 1', ?, ?)",
    )
    .bind(&id)
    .bind(operator_id)
    .bind(badge_phc)
    .bind(app.state.timestamp())
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((id, rev))
}

/// Deactivate or reactivate an operator at a new revision the way the office
/// writers do: a deactivation writes the tombstone, a reactivation drops it.
/// Returns the revision.
async fn set_active(app: &TestApp, id: &str, active: bool) -> i64 {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE operators SET active = ?, rev = ? WHERE id = ?")
        .bind(active)
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    if active {
        markiro_host::feed::restore(&mut tx, "operators", id)
            .await
            .unwrap();
    } else {
        markiro_host::feed::remove(&mut tx, "operators", id, rev)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    rev
}

/// Revoke a badge at a new revision with its tombstone; returns the revision.
async fn revoke_badge(app: &TestApp, id: &str) -> i64 {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE operator_badges SET revoked_at = ?, rev = ? WHERE id = ?")
        .bind(app.state.timestamp())
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    markiro_host::feed::remove(&mut tx, "operator_badges", id, rev)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rev
}

fn operator_item(id: &str, rev: i64) -> Value {
    json!({
        "entity": "operators", "id": id, "rev": rev, "deleted": false,
        "data": { "login": "0042", "name": "Оператор 0042", "role": null, "pinPhc": PIN_PHC }
    })
}

fn badge_item(id: &str, operator_id: &str, rev: i64) -> Value {
    json!({
        "entity": "operator_badges", "id": id, "rev": rev, "deleted": false,
        "data": { "operatorId": operator_id, "badgePhc": BADGE_PHC, "label": "Пропуск 1" }
    })
}

fn tombstone(entity: &str, id: &str, rev: i64) -> Value {
    json!({ "entity": entity, "id": id, "rev": rev, "deleted": true })
}

#[tokio::test]
async fn active_operators_and_their_badges_ride_the_feed() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, operator_rev) = add_operator(&app, "0042").await;
    let (badge, badge_rev) = insert_badge(&app, &operator, BADGE_PHC).await.unwrap();

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"],
        json!([
            operator_item(&operator, operator_rev),
            badge_item(&badge, &operator, badge_rev)
        ])
    );
}

#[tokio::test]
async fn a_deactivated_operator_leaves_the_feed_as_a_tombstone() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, _) = add_operator(&app, "0042").await;
    let (badge, badge_rev) = insert_badge(&app, &operator, BADGE_PHC).await.unwrap();
    let off = set_active(&app, &operator, false).await;

    // A station that has the operator learns that it is gone...
    let (_, body) = changes(&app, &key, &format!("?since={badge_rev}")).await;
    assert_eq!(
        body["items"],
        json!([tombstone("operators", &operator, off)])
    );
    // ...and one syncing from zero never gets the record: only the badge,
    // which grants nothing without it, and the tombstone.
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        body["items"],
        json!([
            badge_item(&badge, &operator, badge_rev),
            tombstone("operators", &operator, off)
        ])
    );
}

#[tokio::test]
async fn a_reactivated_operator_comes_back_without_its_tombstone() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, _) = add_operator(&app, "0042").await;
    let off = set_active(&app, &operator, false).await;
    let on = set_active(&app, &operator, true).await;

    let tombstones: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tombstones")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(tombstones, 0, "re-creating a key drops its tombstone");
    // A station that applied the tombstone gets the record back...
    let (_, body) = changes(&app, &key, &format!("?since={off}")).await;
    assert_eq!(body["items"], json!([operator_item(&operator, on)]));
    // ...and one syncing from zero sees only the record, never both.
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(body["items"], json!([operator_item(&operator, on)]));
}

#[tokio::test]
async fn a_revoked_badge_leaves_the_feed_as_a_tombstone() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, operator_rev) = add_operator(&app, "0042").await;
    let (badge, badge_rev) = insert_badge(&app, &operator, BADGE_PHC).await.unwrap();
    let revoked = revoke_badge(&app, &badge).await;

    let (_, body) = changes(&app, &key, &format!("?since={badge_rev}")).await;
    assert_eq!(
        body["items"],
        json!([tombstone("operator_badges", &badge, revoked)])
    );
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        body["items"],
        json!([
            operator_item(&operator, operator_rev),
            tombstone("operator_badges", &badge, revoked)
        ])
    );
}

#[tokio::test]
async fn one_badge_is_active_for_one_operator_at_a_time() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (first, _) = add_operator(&app, "0042").await;
    let (second, _) = add_operator(&app, "0043").await;
    let (badge, _) = insert_badge(&app, &first, BADGE_PHC).await.unwrap();

    let error = insert_badge(&app, &second, BADGE_PHC).await.unwrap_err();
    assert!(
        error
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation()),
        "{error}"
    );
    // A revoked badge frees its code for another operator.
    revoke_badge(&app, &badge).await;
    insert_badge(&app, &second, BADGE_PHC).await.unwrap();
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline`
Expected: FAIL — не компилируется: ``error[E0433]: failed to resolve: could not find `feed` in `markiro_host` ``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::OperatorBadgeRecord`, `markiro_proto::OperatorRecord` ``.

- [ ] **Step 3: Миграция, `feed`, сущности ленты и записи протокола**

1. Create `apps/standalone/host/migrations/0007_people.sql`:

```sql
-- People and counterparties (spec §4.3). Operators sign in on stations with a
-- PIN or a badge; the office computes both hashes with `@markiro/domain`, so
-- the host stores PBKDF2 PHC strings and never sees a PIN or a badge code.
-- Counterparties are the customers of contract manufacturing; they are not in
-- the station feed.
CREATE TABLE counterparties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  inn TEXT CHECK (inn IS NULL OR (length(inn) IN (10, 12) AND inn NOT GLOB '*[^0-9]*')),
  gln TEXT NOT NULL CHECK (length(gln) = 13 AND gln NOT GLOB '*[^0-9]*'),
  gs1_prefixes TEXT NOT NULL CHECK (json_valid(gs1_prefixes) AND json_type(gs1_prefixes) = 'array'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL
);

-- An operator is in the station feed only while active: a deactivation writes
-- a tombstone, a reactivation drops it and sends the record again (`feed`).
-- `login` is the personnel number typed on the station keypad.
CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE CHECK (length(login) BETWEEN 3 AND 12 AND login NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  role TEXT CHECK (role IS NULL OR length(trim(role)) BETWEEN 1 AND 120),
  pin_phc TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE INDEX operators_rev ON operators (rev);

-- A badge is hashed with the site's badge salt, so one badge code always gives
-- one string and the partial unique index keeps it on one operator. A badge is
-- in the station feed only while not revoked: a revocation writes a tombstone,
-- and a revoked badge never comes back (a new badge gets a new id).
CREATE TABLE operator_badges (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators (id),
  badge_phc TEXT NOT NULL,
  label TEXT CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX operator_badges_active_phc ON operator_badges (badge_phc) WHERE revoked_at IS NULL;
CREATE INDEX operator_badges_operator ON operator_badges (operator_id);
CREATE INDEX operator_badges_rev ON operator_badges (rev);
```

2. Create `apps/standalone/host/src/feed.rs`:

```rust
//! Station-feed bookkeeping for writers (spec §4.4). A record that leaves the
//! feed — deleted, or no longer granting access, like a deactivated operator
//! or a revoked badge — leaves with a tombstone, never with a flag: a station
//! build that reads records leniently would drop a flag it does not know and
//! keep the access. A key that comes back, like a reactivated operator, drops
//! its tombstone, so the feed never carries both.

use sqlx::SqliteConnection;

/// `entity`/`id` left the station feed at `rev`: write its tombstone, or move
/// an older one up to `rev`.
pub async fn remove(
    conn: &mut SqliteConnection,
    entity: &str,
    id: &str,
    rev: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO tombstones (entity, id, rev) VALUES (?, ?, ?) \
         ON CONFLICT (entity, id) DO UPDATE SET rev = excluded.rev",
    )
    .bind(entity)
    .bind(id)
    .bind(rev)
    .execute(conn)
    .await?;
    Ok(())
}

/// `entity`/`id` is back in the station feed: drop its tombstone. A device
/// that applied the tombstone gets the record again through its newer `rev`.
pub async fn restore(
    conn: &mut SqliteConnection,
    entity: &str,
    id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM tombstones WHERE entity = ? AND id = ?")
        .bind(entity)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
```

3. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod error;
pub mod logging;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod error;
pub mod feed;
pub mod logging;
```

4. В `apps/standalone/host/src/routes/changes.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! one. Adding an entity means a branch in `FEED_KEYS` and in `record`, its
//! proto record type, Zod schema and fixture, and a tombstone wherever it is
//! deleted.
```

заменить на

<!-- prettier-ignore -->
```rust
//! one. Adding an entity means a branch in `FEED_KEYS` and in `record`, its
//! proto record type, Zod schema and fixture, and a tombstone wherever it is
//! deleted or stops granting access (`feed`).
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{entities, ChangeItem, ChangesResponse, LineRecord, OrgRecord, SiteRecord};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    entities, ChangeItem, ChangesResponse, LineRecord, OperatorBadgeRecord, OperatorRecord,
    OrgRecord, Secret, SiteRecord,
};
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// Every feed record changed after `?1`: live rows of each entity, then
/// tombstones. `site` joins only once the wizard has initialized the host.
const FEED_KEYS: &str = "\
    SELECT 'org_profile' AS entity, '1' AS id, rev, 0 AS deleted FROM org_profile WHERE rev > ?1 \
    UNION ALL SELECT 'site', '1', rev, 0 FROM site WHERE rev > ?1 AND initialized_at IS NOT NULL \
    UNION ALL SELECT 'lines', id, rev, 0 FROM lines WHERE rev > ?1 \
    UNION ALL SELECT entity, id, rev, 1 FROM tombstones WHERE rev > ?1";
```

заменить на

<!-- prettier-ignore -->
```rust
/// Every feed record changed after `?1`: live rows of each entity, then
/// tombstones. `site` joins only once the wizard has initialized the host;
/// an operator only while active and a badge only while not revoked, since
/// their tombstones say they left.
const FEED_KEYS: &str = "\
    SELECT 'org_profile' AS entity, '1' AS id, rev, 0 AS deleted FROM org_profile WHERE rev > ?1 \
    UNION ALL SELECT 'site', '1', rev, 0 FROM site WHERE rev > ?1 AND initialized_at IS NOT NULL \
    UNION ALL SELECT 'lines', id, rev, 0 FROM lines WHERE rev > ?1 \
    UNION ALL SELECT 'operators', id, rev, 0 FROM operators WHERE rev > ?1 AND active = 1 \
    UNION ALL SELECT 'operator_badges', id, rev, 0 FROM operator_badges WHERE rev > ?1 AND revoked_at IS NULL \
    UNION ALL SELECT entity, id, rev, 1 FROM tombstones WHERE rev > ?1";
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
            serde_json::to_value(LineRecord { name, archived })
        }
```

заменить на

<!-- prettier-ignore -->
```rust
            serde_json::to_value(LineRecord { name, archived })
        }
        entities::OPERATORS => {
            let (login, name, role, pin_phc): (String, String, Option<String>, String) =
                sqlx::query_as("SELECT login, name, role, pin_phc FROM operators WHERE id = ?")
                    .bind(&key.id)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?;
            serde_json::to_value(OperatorRecord {
                login,
                name,
                role,
                pin_phc: Secret::new(pin_phc),
            })
        }
        entities::OPERATOR_BADGES => {
            let (operator_id, badge_phc, label): (String, String, Option<String>) = sqlx::query_as(
                "SELECT operator_id, badge_phc, label FROM operator_badges WHERE id = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(OperatorBadgeRecord {
                operator_id,
                badge_phc: Secret::new(badge_phc),
                label,
            })
        }
```

8. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// Entities of the change feed (spec §4.4). Plans 1d and 1e add operators,
/// badges, products, templates and template defaults.
pub mod entities {
    pub const ORG_PROFILE: &str = "org_profile";
    pub const SITE: &str = "site";
    pub const LINES: &str = "lines";
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// Entities of the change feed (spec §4.4). Plan 1e adds products,
/// templates and template defaults.
pub mod entities {
    pub const ORG_PROFILE: &str = "org_profile";
    pub const SITE: &str = "site";
    pub const LINES: &str = "lines";
    pub const OPERATORS: &str = "operators";
    pub const OPERATOR_BADGES: &str = "operator_badges";
}
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`], …); absent
    /// when `deleted`.
```

заменить на

<!-- prettier-ignore -->
```rust
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`],
    /// [`OperatorRecord`], [`OperatorBadgeRecord`]); absent when `deleted`.
```

10. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// `data` of a `lines` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRecord {
    pub name: String,
    pub archived: bool,
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// `data` of a `lines` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRecord {
    pub name: String,
    pub archived: bool,
}

/// `data` of an `operators` item. Only an active operator is in the feed: a
/// deactivation arrives as a tombstone, never as a flag (spec §4.4), and a
/// PIN change as a record with the new hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorRecord {
    /// Personnel number: 3-12 digits, typed on the station keypad.
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    /// PBKDF2 PHC string of the PIN (`@markiro/domain`).
    pub pin_phc: Secret,
}

/// `data` of an `operator_badges` item. Only a badge that is not revoked is
/// in the feed: a revocation arrives as a tombstone. A badge grants nothing
/// by itself: a station signs in with it only while the record of its
/// operator is there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorBadgeRecord {
    pub operator_id: String,
    /// PBKDF2 PHC string of the badge code, with the site's badge salt.
    pub badge_phc: Secret,
    pub label: Option<String>,
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline`
Expected: PASS — 14 тестов (9 прежних и 5 новых).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 2 модульных теста и 21 тест фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «Change feed», фрагмент

<!-- prettier-ignore -->
```text
`GET /v1/changes?since=<rev>&limit=<n>` (`routes/changes.rs`) returns the
station-visible reference records changed after a device's revision:
`org_profile`, `site` (badge salt and block sizes), `lines`, plus deletions
from `tombstones`. Pages are ordered by `(rev, entity, id)` and never split a
revision; with `hasMore = false`, `rev` is the host's current revision, so
revisions that changed only office data still move a device forward.
`GET /v1/changes/stream` sends the current revision as its first event, then
an event whenever the revision grew: events are strictly increasing, so a
burst of commits collapses into one, and an event means "fetch since your
revision", not "a commit happened"; a comment heartbeat keeps the connection
alive every 15 s, and streams end when the host stops. A new feed entity
needs a branch in `FEED_KEYS` and in `record`, its proto record type, Zod
schema and fixture, a tombstone wherever it is deleted, the station's local
table, an index on the new table's `rev` (as `lines_rev`), and that
re-creating a key deletes its tombstone.
```

заменить на

<!-- prettier-ignore -->
```text
`GET /v1/changes?since=<rev>&limit=<n>` (`routes/changes.rs`) returns the
station-visible reference records changed after a device's revision:
`org_profile`, `site` (badge salt and block sizes), `lines`, `operators`,
`operator_badges`, plus deletions from `tombstones`. Pages are ordered by
`(rev, entity, id)` and never split a revision; with `hasMore = false`,
`rev` is the host's current revision, so revisions that changed only office
data still move a device forward.
`GET /v1/changes/stream` sends the current revision as its first event, then
an event whenever the revision grew: events are strictly increasing, so a
burst of commits collapses into one, and an event means "fetch since your
revision", not "a commit happened"; a comment heartbeat keeps the connection
alive every 15 s, and streams end when the host stops. A new feed entity
needs a branch in `FEED_KEYS` and in `record`, its proto record type, Zod
schema and fixture, a tombstone wherever it is deleted or stops granting
access, the station's local table, an index on the new table's `rev` (as
`lines_rev`), and that re-creating a key deletes its tombstone. Writers use
`feed::remove` and `feed::restore` for both.

A change that removes access rides the feed as a tombstone, never as a
flag: the webview reads records with `z.object`, which drops unknown keys,
so a newer host expressing a revocation as a new field would leave an older
station with the access. An operator is in the feed only while active: a
deactivation writes a tombstone for its id, and a reactivation drops the
tombstone and sends the record again with a new `rev`. A badge is in the
feed only while not revoked: a revocation writes a tombstone, and a revoked
badge never comes back — a new badge gets a new id. A PIN change is a record
update carrying the new `pinPhc`, so the station replaces the hash and the
old PIN stops working. A badge record never grants access on its own: the
station's operator login (plan 1f) requires the record of its `operatorId`.
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.4, фрагмент

<!-- prettier-ignore -->
```text
  `label_templates`, `category_template_defaults`. Офисные пользователи, сессии,
  устройства, коды подключения и журнал действий в ленту не входят.
```

заменить на

<!-- prettier-ignore -->
```text
  `label_templates`, `category_template_defaults`. Офисные пользователи, сессии,
  устройства, коды подключения и журнал действий в ленту не входят.
- Изменение, которое закрывает доступ, идёт по ленте надгробием, а не флагом:
  вебвью читает записи через `z.object`, и незнакомое поле более нового хоста
  просто отбросилось бы. Оператор в ленте, только пока активен: выключение пишет
  надгробие, повторное включение удаляет его и снова отдаёт запись с новой
  ревизией. Бейдж в ленте, только пока не отозван: отзыв пишет надгробие,
  отозванный бейдж не возвращается, новый бейдж получает новый идентификатор.
  Смена PIN — обновление записи с новым `pinPhc`. Запись бейджа сама доступа не
  даёт: вход оператора на станции (план 1f) требует запись оператора с этим
  `operatorId`.
- Ключ, который вернулся в ленту после надгробия (оператор включён снова),
  удаляет своё надгробие: лента никогда не несёт и надгробие, и запись одного
  ключа (`feed::restore`).
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/changes-people.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

```bash
git add apps/standalone/host/migrations/0007_people.sql apps/standalone/host/src/feed.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/routes/changes.rs apps/standalone/host/tests/changes.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/changes-people.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): операторы и бейджи в модели хоста и в ленте, надгробия вместо флагов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Контрагенты — `GET/POST/PUT /v1/office/counterparties`

Контрагенты — заказчики контрактного производства. Читают все роли, пишет администратор; архивирование — `archived: true` в `PUT`, удаления нет. В ленту станций контрагенты не входят, но изменение всё равно берёт ревизию, как у всех записей с `rev`: по ней работает `expectedRev`.

Проверки полей — те же, что у профиля организации. Поэтому проверки имени, ИНН, GLN и префиксов выносятся из `validate::org` в `validate::company`, и обе формы вызывают одну функцию. У `validate.rs` появляются модульные тесты (отложено с плана 1b1); `ApiError::details` открывает деталь ошибки для них.

`PUT` принимает запись целиком, как профиль организации: форма контрагента правит все поля сразу, а частичное обновление потребовало бы различать «поле не прислано» и «`inn: null` — очистить».

Здесь же появляется общая поддержка интеграционных тестов в `tests/support/app.rs`: `Admin` с сессией администратора, `host_revision` и `audit_trail`. Ими пользуются новые тесты задач 2–7; прежние копии переходят на них в задаче 8.

**Files:**

- Create: `apps/standalone/host/src/routes/counterparties.rs`, `apps/standalone/host/tests/counterparties.rs`
- Create: `apps/standalone/proto/fixtures/counterparty-record.json`, `counterparty-create.json`, `counterparty-update.json`
- Modify: `apps/standalone/host/src/{validate,error,audit,server}.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Audit»), спецификация §4.3, §4.5, §4.9

**Interfaces:**

- Consumes:
  - `OfficeContext::{require_admin, require_admin_in, actor}` — `host/src/auth.rs`;
  - `audit::{record, update_details, Entry, Outcome}` — `host/src/audit.rs`;
  - таблица `counterparties` (задача 1);
  - `TestApp`, `pair_device`, `bootstrap`, `seed_office_user`, `login`, `with_session`, `request`, `json`, `empty` — `host/tests/support/app.rs`.
- Produces:
  - `pub struct ValidCompany { name, inn: Option<String>, gln, gs1_prefixes: Vec<String> }` и `pub fn validate::company(prefix: &str, name: &str, inn: Option<&str>, gln: &str, gs1_prefixes: &[String]) -> Result<ValidCompany, ApiError>`;
  - `pub fn ApiError::details(&self) -> Option<&serde_json::Map<String, Value>>`;
  - `actions::COUNTERPARTY_CREATE = "counterparty.create"`, `actions::COUNTERPARTY_UPDATE = "counterparty.update"`;
  - `CounterpartyRecord { id, name, inn, gln, gs1_prefixes, archived, rev }`, `CounterpartyCreate { name, inn, gln, gs1_prefixes }`, `CounterpartyUpdate { name, inn, gln, gs1_prefixes, archived, expected_rev }` — `proto/src/lib.rs`;
  - тестовая поддержка: `pub struct Admin { app, key, token, id }`, `pub async fn admin() -> Admin`, `Admin::{call, call_as, technologist, row}`, `pub async fn host_revision(app: &TestApp) -> i64`, `pub type AuditRow`, `pub async fn audit_trail(app: &TestApp, action: &str) -> Vec<AuditRow>`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/host/tests/support/app.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
/// Run the wizard from loopback with `device_key`; returns the admin's token.
pub async fn bootstrap(app: &TestApp, device_key: &str) -> String {
    let (status, body) = app
        .send(json(
            with_device(request("POST", "/v1/bootstrap"), device_key),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["session"]["token"].as_str().unwrap().to_owned()
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// Run the wizard from loopback with `device_key`; returns the admin's token.
pub async fn bootstrap(app: &TestApp, device_key: &str) -> String {
    let (status, body) = app
        .send(json(
            with_device(request("POST", "/v1/bootstrap"), device_key),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["session"]["token"].as_str().unwrap().to_owned()
}

/// A host after the wizard, with the administrator signed in on the station
/// that ran it.
pub struct Admin {
    pub app: TestApp,
    pub key: String,
    pub token: String,
    pub id: String,
}

/// A new host: a paired station runs the wizard, and the administrator's
/// session stays open on it.
pub async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (status, me) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let id = me["id"].as_str().unwrap().to_owned();
    Admin {
        app,
        key,
        token,
        id,
    }
}

impl Admin {
    /// An office request with the administrator's session.
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.call_as(&self.token, method, path, body).await
    }

    /// An office request with another session on the same station.
    pub async fn call_as(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = with_session(request(method, path), &self.key, token);
        match body {
            Some(body) => self.app.send(json(builder, body)).await,
            None => self.app.send(empty(builder)).await,
        }
    }

    /// A technologist signed in on the same station; returns the token.
    pub async fn technologist(&self) -> String {
        seed_office_user(&self.app, "tech", "technologist", "technologist password").await;
        login(&self.app, &self.key, "tech", "technologist password").await
    }

    /// The `ok` audit row a change by this administrator writes.
    pub fn row(
        &self,
        action: &str,
        target_type: &str,
        target_id: &str,
        details: Value,
    ) -> AuditRow {
        (
            "office_user".to_owned(),
            Some(self.id.clone()),
            action.to_owned(),
            Some(target_type.to_owned()),
            Some(target_id.to_owned()),
            "ok".to_owned(),
            details,
        )
    }
}

/// The host's current revision (`host_revision.rev`).
pub async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// An audit row: actor kind and id, action, target type and id, result and
/// the parsed `details`.
pub type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Value,
);

/// Every audit row of `action`, oldest first.
pub async fn audit_trail(app: &TestApp, action: &str) -> Vec<AuditRow> {
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
         FROM audit_log WHERE action = ? ORDER BY id",
    )
    .bind(action)
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(
            |(kind, id, action, target_type, target_id, result, details)| {
                (
                    kind,
                    id,
                    action,
                    target_type,
                    target_id,
                    result,
                    serde_json::from_str(&details).unwrap(),
                )
            },
        )
        .collect()
}
```

2. Create `apps/standalone/host/tests/counterparties.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, audit_trail, empty, host_revision, request, with_device};

const BEREG: &str = "ООО «Северный берег»";

fn new_counterparty() -> Value {
    json!({
        "name": " ООО «Северный берег» ",
        "inn": " ",
        "gln": "4601234000017",
        "gs1Prefixes": ["4601234", " 4601234 ", "4609876"]
    })
}

fn full(inn: Value, archived: bool, expected_rev: i64) -> Value {
    json!({
        "name": BEREG,
        "inn": inn,
        "gln": "4601234000017",
        "gs1Prefixes": ["4601234", "4609876"],
        "archived": archived,
        "expectedRev": expected_rev
    })
}

#[tokio::test]
async fn an_administrator_creates_lists_and_updates_counterparties() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1.
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(
        created,
        json!({
            "id": id, "name": BEREG, "inn": null, "gln": "4601234000017",
            "gs1Prefixes": ["4601234", "4609876"], "archived": false, "rev": 2
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "counterparty.create").await,
        vec![admin.row(
            "counterparty.create",
            "counterparty",
            &id,
            json!({ "name": BEREG, "gln": "4601234000017" })
        )]
    );
    let (status, list) = admin.call("GET", "/v1/office/counterparties", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([created])));

    let path = format!("/v1/office/counterparties/{id}");
    let (status, archived) = admin
        .call("PUT", &path, Some(full(json!("7812345678"), true, 2)))
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(
        (
            archived["inn"].clone(),
            archived["archived"].clone(),
            archived["rev"].clone()
        ),
        (json!("7812345678"), json!(true), json!(3))
    );
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await,
        vec![admin.row(
            "counterparty.update",
            "counterparty",
            &id,
            json!({
                "changed": ["inn", "archived"],
                "inn": { "from": null, "to": "7812345678" },
                "archived": { "from": false, "to": true }
            })
        )]
    );

    // The same values again change nothing.
    let (status, unchanged) = admin
        .call("PUT", &path, Some(full(json!("7812345678"), true, 3)))
        .await;
    assert_eq!((status, unchanged), (StatusCode::OK, archived));
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await.len(),
        1
    );

    // An update over an old revision is refused.
    let (status, body) = admin
        .call("PUT", &path, Some(full(Value::Null, false, 2)))
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(3))
    );
}

#[tokio::test]
async fn counterparties_are_not_in_the_station_feed() {
    let admin = admin().await;
    let (status, _) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, feed) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/changes?since=1"),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        feed,
        json!({ "hostId": admin.app.state.host_id, "rev": 2, "hasMore": false, "items": [] })
    );
}

#[tokio::test]
async fn counterparty_fields_follow_the_organization_rules() {
    let admin = admin().await;
    for (body, field) in [
        (
            json!({ "name": " ", "gln": "4601234000017", "gs1Prefixes": [] }),
            "name",
        ),
        (
            json!({ "name": "Берег", "inn": "12345", "gln": "4601234000017", "gs1Prefixes": [] }),
            "inn",
        ),
        (
            json!({ "name": "Берег", "gln": "460123400001", "gs1Prefixes": [] }),
            "gln",
        ),
        (
            json!({ "name": "Берег", "gln": "4601234000017", "gs1Prefixes": ["46"] }),
            "gs1Prefixes",
        ),
    ] {
        let (status, error) = admin
            .call("POST", "/v1/office/counterparties", Some(body))
            .await;
        assert_eq!(
            (status, error["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field))
        );
    }
    let (status, error) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(
                json!({ "name": "Берег", "gln": "4601234000017", "gs1Prefixes": [], "notes": "" }),
            ),
        )
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM counterparties")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(audit_trail(&admin.app, "counterparty.create")
        .await
        .is_empty());
}

#[tokio::test]
async fn technologists_read_counterparties_but_do_not_change_them() {
    let admin = admin().await;
    let (_, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    let tech = admin.technologist().await;

    let (status, list) = admin
        .call_as(&tech, "GET", "/v1/office/counterparties", None)
        .await;
    assert_eq!((status, list), (StatusCode::OK, json!([created.clone()])));
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let path = format!(
        "/v1/office/counterparties/{}",
        created["id"].as_str().unwrap()
    );
    let (status, _) = admin
        .call_as(&tech, "PUT", &path, Some(full(Value::Null, true, 2)))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        audit_trail(&admin.app, "counterparty.create").await.len(),
        1
    );
    assert!(audit_trail(&admin.app, "counterparty.update")
        .await
        .is_empty());
}

#[tokio::test]
async fn an_unknown_counterparty_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/counterparties/9b2e4a6c-0000-4000-8000-000000000000";
    let mut invalid = full(Value::Null, false, 1);
    invalid["gln"] = json!("1");
    let (status, body) = admin.call("PUT", path, Some(invalid)).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("gln"))
    );
    let (status, body) = admin
        .call("PUT", path, Some(full(Value::Null, false, 1)))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}
```

3. Create `apps/standalone/proto/fixtures/counterparty-record.json`:

```json
{
  "id": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  "name": "ООО «Северный берег»",
  "inn": "7812345678",
  "gln": "4601234000017",
  "gs1Prefixes": ["4601234"],
  "archived": false,
  "rev": 12
}
```

4. Create `apps/standalone/proto/fixtures/counterparty-create.json`:

```json
{ "name": "ООО «Северный берег»", "inn": null, "gln": "4601234000017", "gs1Prefixes": ["4601234"] }
```

5. Create `apps/standalone/proto/fixtures/counterparty-update.json`:

```json
{
  "name": "ООО «Северный берег»",
  "inn": "7812345678",
  "gln": "4601234000017",
  "gs1Prefixes": ["4601234", "4609876"],
  "archived": true,
  "expectedRev": 12
}
```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord,
    ErrorBody, Hello, HelloEnvelope, LineRecord, LocalPairRequest, OfficeLoginRequest, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorRecord, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PasswordChange, PasswordSet, SiteRecord, SsccCounterUpdate, SsccState,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, ErrorBody, Hello, HelloEnvelope,
    LineRecord, LocalPairRequest, OfficeLoginRequest, OfficeRole, OfficeSession, OfficeUser,
    OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorRecord,
    OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange,
    PasswordSet, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn counterparty_fixtures_round_trip_and_requests_reject_unknown_fields() {
    let record: CounterpartyRecord = round_trip("counterparty-record.json");
    assert!(!record.archived);
    let create: CounterpartyCreate = round_trip("counterparty-create.json");
    assert_eq!(create.inn, None);
    let update: CounterpartyUpdate = round_trip("counterparty-update.json");
    assert!(update.archived);
    let mut value = fixture("counterparty-create.json");
    value["notes"] = Value::Bool(true);
    assert!(serde_json::from_value::<CounterpartyCreate>(value).is_err());
    let mut value = fixture("counterparty-update.json");
    value["notes"] = Value::Bool(true);
    assert!(serde_json::from_value::<CounterpartyUpdate>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
```

8. В `apps/standalone/host/src/validate.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
pub fn sscc_serial(field: &str, extension: u8, prefix: &str, serial: u64) -> Result<(), ApiError> {
    let capacity = serial_capacity(prefix);
    if serial < first_serial(extension) || serial >= capacity {
        Err(ApiError::validation(
            field,
            format!(
                "the serial must be {}..{}",
                first_serial(extension),
                capacity - 1
            ),
        ))
    } else {
        Ok(())
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
pub fn sscc_serial(field: &str, extension: u8, prefix: &str, serial: u64) -> Result<(), ApiError> {
    let capacity = serial_capacity(prefix);
    if serial < first_serial(extension) || serial >= capacity {
        Err(ApiError::validation(
            field,
            format!(
                "the serial must be {}..{}",
                first_serial(extension),
                capacity - 1
            ),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `details.field` of a validation error.
    fn field<T: std::fmt::Debug>(result: Result<T, ApiError>) -> String {
        let error = result.expect_err("a validation error");
        assert_eq!(error.code(), "validation_failed");
        error
            .details()
            .and_then(|details| details.get("field"))
            .and_then(|field| field.as_str())
            .expect("details.field")
            .to_owned()
    }

    const GLN: &str = "4601234000017";

    #[test]
    fn company_fields_are_trimmed_and_normalized() {
        let prefixes = [
            " 4601234 ".to_owned(),
            "4601234".to_owned(),
            "4609876".to_owned(),
        ];
        assert_eq!(
            company("", " ООО «Берег» ", Some(" "), " 4601234000017 ", &prefixes).unwrap(),
            ValidCompany {
                name: "ООО «Берег»".to_owned(),
                inn: None,
                gln: GLN.to_owned(),
                gs1_prefixes: vec!["4601234".to_owned(), "4609876".to_owned()],
            }
        );
        let twelve = company("", "Берег", Some("781234567890"), GLN, &[]).unwrap();
        assert_eq!(twelve.inn.as_deref(), Some("781234567890"));
        assert_eq!(
            company("", &"я".repeat(200), None, GLN, &[])
                .unwrap()
                .name
                .chars()
                .count(),
            200
        );
    }

    #[test]
    fn company_errors_name_the_field_under_its_prefix() {
        assert_eq!(field(company("", " ", None, GLN, &[])), "name");
        assert_eq!(field(company("", &"я".repeat(201), None, GLN, &[])), "name");
        assert_eq!(
            field(company("org", "Берег", Some("12345678901"), GLN, &[])),
            "org.inn"
        );
        assert_eq!(
            field(company("", "Берег", None, "460123400001", &[])),
            "gln"
        );
        assert_eq!(
            field(company("", "Берег", None, GLN, &["460".to_owned()])),
            "gs1Prefixes"
        );
        let eleven: Vec<String> = (0..11).map(|n| format!("46012{n:02}")).collect();
        assert_eq!(
            field(company("", "Берег", None, GLN, &eleven)),
            "gs1Prefixes"
        );
    }
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test counterparties --offline`
Expected: FAIL — 5 тестов из 5: маршрутов ещё нет, и хост отвечает `404` там, где тесты ждут `200` или `400`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: FAIL — не компилируется: ``error[E0425]: cannot find function `company` in this scope``, ``error[E0422]: cannot find struct, variant or union type `ValidCompany` in this scope`` и ``error[E0599]: no method named `details` found for struct `ApiError` ``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::CounterpartyCreate`, `markiro_proto::CounterpartyRecord`, `markiro_proto::CounterpartyUpdate` ``.

- [ ] **Step 3: Проверки полей, записи протокола и маршруты**

1. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
fn digits(text: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Validate organization fields; `prefix` is the JSON path of the object in
/// the request (`org` in the wizard, empty for `PUT /v1/office/org`).
pub fn org(prefix: &str, input: &OrgProfileInput) -> Result<ValidOrg, ApiError> {
    let field = |name: &str| {
        if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}.{name}")
        }
    };
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::validation(
            &field("name"),
            "the name must be 1-200 characters",
        ));
    }
    let inn = match input.inn.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(inn) if digits(inn, 10..=10) || digits(inn, 12..=12) => Some(inn.to_owned()),
        Some(_) => {
            return Err(ApiError::validation(
                &field("inn"),
                "the INN must be 10 or 12 digits",
            ))
        }
    };
    let gln = input.gln.trim();
    if !digits(gln, 13..=13) {
        return Err(ApiError::validation(
            &field("gln"),
            "the GLN must be 13 digits",
        ));
    }
    let mut gs1_prefixes: Vec<String> = Vec::new();
    for gs1_prefix in &input.gs1_prefixes {
        let gs1_prefix = gs1_prefix.trim();
        if !digits(gs1_prefix, 4..=12) {
            return Err(ApiError::validation(
                &field("gs1Prefixes"),
                "each GS1 prefix must be 4-12 digits",
            ));
        }
        if !gs1_prefixes.iter().any(|known| known == gs1_prefix) {
            gs1_prefixes.push(gs1_prefix.to_owned());
        }
    }
    if gs1_prefixes.len() > 10 {
        return Err(ApiError::validation(
            &field("gs1Prefixes"),
            "at most 10 GS1 prefixes",
        ));
    }
    let time_zone = input.time_zone.trim();
    let time_zone_ok = (1..=64).contains(&time_zone.len())
        && time_zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'));
    if !time_zone_ok {
        return Err(ApiError::validation(
            &field("timeZone"),
            "an IANA time zone name is required",
        ));
    }
    Ok(ValidOrg {
        name: name.to_owned(),
        inn,
        gln: gln.to_owned(),
        gs1_prefixes,
        time_zone: time_zone.to_owned(),
    })
}
```

заменить на

<!-- prettier-ignore -->
```rust
fn digits(text: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// The JSON path of the field `name` in the object at `prefix` (empty for the
/// request's top level).
fn path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}.{name}")
    }
}

/// Company fields after validation (trimmed, normalized): the organization's
/// and a counterparty's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidCompany {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
}

/// Validate company fields: a name of 1-200 characters, an INN of 10 or 12
/// digits or none (blank is none), a 13-digit GLN, at most 10 distinct GS1
/// prefixes of 4-12 digits. `prefix` is the JSON path of the object in the
/// request.
pub fn company(
    prefix: &str,
    name: &str,
    inn: Option<&str>,
    gln: &str,
    gs1_prefixes: &[String],
) -> Result<ValidCompany, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::validation(
            &path(prefix, "name"),
            "the name must be 1-200 characters",
        ));
    }
    let inn = match inn.map(str::trim) {
        None | Some("") => None,
        Some(inn) if digits(inn, 10..=10) || digits(inn, 12..=12) => Some(inn.to_owned()),
        Some(_) => {
            return Err(ApiError::validation(
                &path(prefix, "inn"),
                "the INN must be 10 or 12 digits",
            ))
        }
    };
    let gln = gln.trim();
    if !digits(gln, 13..=13) {
        return Err(ApiError::validation(
            &path(prefix, "gln"),
            "the GLN must be 13 digits",
        ));
    }
    let mut valid_prefixes: Vec<String> = Vec::new();
    for gs1_prefix in gs1_prefixes {
        let gs1_prefix = gs1_prefix.trim();
        if !digits(gs1_prefix, 4..=12) {
            return Err(ApiError::validation(
                &path(prefix, "gs1Prefixes"),
                "each GS1 prefix must be 4-12 digits",
            ));
        }
        if !valid_prefixes.iter().any(|known| known == gs1_prefix) {
            valid_prefixes.push(gs1_prefix.to_owned());
        }
    }
    if valid_prefixes.len() > 10 {
        return Err(ApiError::validation(
            &path(prefix, "gs1Prefixes"),
            "at most 10 GS1 prefixes",
        ));
    }
    Ok(ValidCompany {
        name: name.to_owned(),
        inn,
        gln: gln.to_owned(),
        gs1_prefixes: valid_prefixes,
    })
}

/// Validate organization fields; `prefix` is the JSON path of the object in
/// the request (`org` in the wizard, empty for `PUT /v1/office/org`).
pub fn org(prefix: &str, input: &OrgProfileInput) -> Result<ValidOrg, ApiError> {
    let company = company(
        prefix,
        &input.name,
        input.inn.as_deref(),
        &input.gln,
        &input.gs1_prefixes,
    )?;
    let time_zone = input.time_zone.trim();
    let time_zone_ok = (1..=64).contains(&time_zone.len())
        && time_zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'));
    if !time_zone_ok {
        return Err(ApiError::validation(
            &path(prefix, "timeZone"),
            "an IANA time zone name is required",
        ));
    }
    Ok(ValidOrg {
        name: company.name,
        inn: company.inn,
        gln: company.gln,
        gs1_prefixes: company.gs1_prefixes,
        time_zone: time_zone.to_owned(),
    })
}
```

2. В `apps/standalone/host/src/error.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub fn code(&self) -> &str {
        &self.body.error.code
    }
```

заменить на

<!-- prettier-ignore -->
```rust
    pub fn code(&self) -> &str {
        &self.body.error.code
    }

    /// The structured detail, if any (`field`, `constraint`, `currentRev`, …).
    pub fn details(&self) -> Option<&serde_json::Map<String, Value>> {
        self.body.error.details.as_ref()
    }
```

3. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const DEVICE_LINE: &str = "device.line";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const DEVICE_LINE: &str = "device.line";
    pub const COUNTERPARTY_CREATE: &str = "counterparty.create";
    pub const COUNTERPARTY_UPDATE: &str = "counterparty.update";
}
```

4. В `apps/standalone/proto/src/lib.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
/// `PUT /v1/office/me/password`: a signed-in office user changes their own password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordChange {
    pub current_password: Secret,
    pub new_password: Secret,
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// `PUT /v1/office/me/password`: a signed-in office user changes their own password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordChange {
    pub current_password: Secret,
    pub new_password: Secret,
}

/// A counterparty (`GET /v1/office/counterparties`): a customer of contract
/// manufacturing. Archived instead of deleted; not in the station feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterpartyRecord {
    pub id: String,
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub archived: bool,
    pub rev: i64,
}

/// `POST /v1/office/counterparties`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CounterpartyCreate {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
}

/// `PUT /v1/office/counterparties/{id}`: every field, like the organization
/// profile; `archived: true` archives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CounterpartyUpdate {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub archived: bool,
    pub expected_rev: i64,
}
```

5. Create `apps/standalone/host/src/routes/counterparties.rs`:

```rust
//! Counterparties (spec §4.3): the customers of contract manufacturing.
//! `GET /v1/office/counterparties` (every role), `POST` and `PUT …/{id}`
//! (administrators, `PUT` with `expectedRev`). A counterparty is archived
//! instead of deleted and is not in the station feed; a change still takes a
//! revision, like every record with a `rev`.

use axum::extract::State;
use axum::Json;
use markiro_proto::{CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

const SELECT: &str = "SELECT id, name, inn, gln, gs1_prefixes, archived, rev FROM counterparties";

#[derive(sqlx::FromRow)]
struct CounterpartyRow {
    id: String,
    name: String,
    inn: Option<String>,
    gln: String,
    gs1_prefixes: String,
    archived: bool,
    rev: i64,
}

fn record(row: CounterpartyRow) -> Result<CounterpartyRecord, ApiError> {
    Ok(CounterpartyRecord {
        id: row.id,
        name: row.name,
        inn: row.inn,
        gln: row.gln,
        gs1_prefixes: serde_json::from_str(&row.gs1_prefixes).map_err(ApiError::internal)?,
        archived: row.archived,
        rev: row.rev,
    })
}

async fn read(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<CounterpartyRecord>, ApiError> {
    let row: Option<CounterpartyRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

pub async fn list_counterparties(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<CounterpartyRecord>>, ApiError> {
    let rows: Vec<CounterpartyRow> =
        sqlx::query_as(&format!("{SELECT} ORDER BY archived, name, id"))
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn create_counterparty(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<CounterpartyCreate>,
) -> Result<Json<CounterpartyRecord>, ApiError> {
    context.require_admin()?;
    let company = validate::company(
        "",
        &create.name,
        create.inn.as_deref(),
        &create.gln,
        &create.gs1_prefixes,
    )?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO counterparties (id, name, inn, gln, gs1_prefixes, archived, rev) \
         VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&company.name)
    .bind(&company.inn)
    .bind(&company.gln)
    .bind(serde_json::to_string(&company.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::COUNTERPARTY_CREATE,
            target_type: Some("counterparty"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": company.name, "gln": company.gln }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("counterparty vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_counterparty(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<CounterpartyUpdate>,
) -> Result<Json<CounterpartyRecord>, ApiError> {
    context.require_admin()?;
    let company = validate::company(
        "",
        &update.name,
        update.inn.as_deref(),
        &update.gln,
        &update.gs1_prefixes,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such counterparty"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(company.name)),
        ("inn", json!(current.inn), json!(company.inn)),
        ("gln", json!(current.gln), json!(company.gln)),
        (
            "gs1Prefixes",
            json!(current.gs1_prefixes),
            json!(company.gs1_prefixes),
        ),
        ("archived", json!(current.archived), json!(update.archived)),
    ]) else {
        // Nothing actually changed: report the record as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE counterparties SET name = ?, inn = ?, gln = ?, gs1_prefixes = ?, archived = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(&company.name)
    .bind(&company.inn)
    .bind(&company.gln)
    .bind(serde_json::to_string(&company.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(update.archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::COUNTERPARTY_UPDATE,
            target_type: Some("counterparty"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("counterparty vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

6. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod bootstrap;
pub mod changes;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod bootstrap;
pub mod changes;
pub mod counterparties;
```

7. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/sscc/block-sizes",
            put(crate::routes::sscc::put_block_sizes),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/sscc/block-sizes",
            put(crate::routes::sscc::put_block_sizes),
        )
        .route(
            "/v1/office/counterparties",
            get(crate::routes::counterparties::list_counterparties)
                .post(crate::routes::counterparties::create_counterparty),
        )
        .route(
            "/v1/office/counterparties/{id}",
            put(crate::routes::counterparties::update_counterparty),
        )
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test counterparties --offline`
Expected: PASS — 5 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
Expected: PASS — 18 тестов (16 прежних и 2 `validate::tests`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test bootstrap --offline`
Expected: PASS — 6 тестов: мастер и профиль организации проверяют поля через `validate::company` с прежними путями полей.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 22 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «Audit», фрагмент

<!-- prettier-ignore -->
```text
login never records the typed login. An attempt refused by a rate limiter
writes no row, so a flood cannot fill the log. `office_user.password` covers
```

заменить на

<!-- prettier-ignore -->
```text
login never records the typed login. An attempt refused by a rate limiter
writes no row, so a flood cannot fill the log. An office write the host
refuses (`validation_failed`, `forbidden`, `not_found`, `stale_revision`,
`conflict`) changed nothing and writes no row either, as for every office
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.3, фрагмент

<!-- prettier-ignore -->
```text
- `counterparties(id, name, inn, gln, gs1_prefixes JSON, archived, rev)`.
```

заменить на

<!-- prettier-ignore -->
```text
- `counterparties(id, name, inn, gln, gs1_prefixes JSON, archived, rev)`. Проверки
  хоста — как у профиля организации (`validate::company`): имя 1–200 символов,
  ИНН 10 или 12 цифр либо пусто, GLN 13 цифр, не больше 10 префиксов по 4–12 цифр.
  Уникальности нет; архивирование — `archived`, удаления нет; в ленту станций не
  входят.
```

3. Там же, §4.5, фрагмент

<!-- prettier-ignore -->
```text
Офисные маршруты требуют и ключ устройства, и токен сессии этого же устройства
(заголовок `X-Office-Session`).
```

заменить на

<!-- prettier-ignore -->
```text
Офисные маршруты требуют и ключ устройства, и токен сессии этого же устройства
(заголовок `X-Office-Session`).

Формы запросов и ответов плана 1d2 закреплены фикстурами `proto/fixtures`:

- контрагенты — `counterparty-record.json` (ответ), `counterparty-create.json`,
  `counterparty-update.json` (`PUT` — запись целиком с `archived` и `expectedRev`).
```

4. Там же, §4.9, фрагмент

<!-- prettier-ignore -->
```text
поля изменились, без значений PIN, паролей и хешей). Экран журнала — этап 5.
```

заменить на

<!-- prettier-ignore -->
```text
поля изменились, без значений PIN, паролей и хешей). Экран журнала — этап 5.

Отказанная запись офиса (ошибка проверки, нет прав, нет записи, `stale_revision`,
`conflict`) ничего не изменила и строки не пишет — так пишут все писатели офиса с
плана 1b1, план 1d2 записал это правилом. Строки с результатом `denied` — отказы
входа, смены своего пароля и подключения по коду.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/counterparty-*.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

```bash
git add apps/standalone/host/src/validate.rs apps/standalone/host/src/error.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/counterparties.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/counterparties.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/counterparty-record.json apps/standalone/proto/fixtures/counterparty-create.json apps/standalone/proto/fixtures/counterparty-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): контрагенты на хосте" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Линии — `GET/POST/PUT /v1/office/lines`

Линии создаёт мастер (план 1b1), и они уже в ленте (план 1c1); маршрутов офиса у них не было. Читают все роли, пишет администратор. Имя уникально среди неархивных линий без учёта регистра — это частичный индекс `lines_active_name_key` по `name_key` (миграция 0002). Нарушение индекса — `conflict` с `constraint: line_name`: при создании, переименовании и возврате из архива, если имя уже занято активной линией.

`PUT` меняет только присланные поля (`name?`, `archived?`) и требует `expectedRev`. Переименование и архивирование берут новую ревизию, поэтому станции получают линию заново. Архивирование не трогает устройства на этой линии: станция на архивной линии остаётся на ней. Что с ней делать, решит план, который начнёт пускать смены на линии (решение плана 1d2, записано в «Перенесено»); выбрать архивную линию станция уже не может (`PUT /v1/device/line`, план 1c1).

**Files:**

- Create: `apps/standalone/host/src/routes/lines.rs`, `apps/standalone/host/tests/lines.rs`
- Create: `apps/standalone/proto/fixtures/office-line.json`, `line-create.json`, `line-update.json`
- Modify: `apps/standalone/host/src/{audit,server}.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/proto/tests/fixtures.rs`
- Modify: спецификация §4.3, §4.5

**Interfaces:**

- Consumes:
  - `validate::line_name(field, name) -> Result<(String, String), ApiError>` (имя и `name_key`) — `host/src/validate.rs`;
  - `Admin`, `admin`, `audit_trail`, `host_revision` — `host/tests/support/app.rs` (задача 2).
- Produces:
  - `actions::LINE_CREATE = "line.create"`, `actions::LINE_UPDATE = "line.update"`;
  - `OfficeLine { id, name, archived, rev }`, `LineCreate { name }`, `LineUpdate { name: Option<String>, archived: Option<bool>, expected_rev }` — `proto/src/lib.rs`;
  - маршруты `GET/POST /v1/office/lines`, `PUT /v1/office/lines/{id}`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/host/tests/lines.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, empty, host_revision, json as json_request, request, with_device, Admin,
};

/// The office list of lines.
async fn lines(admin: &Admin) -> Vec<Value> {
    let (status, body) = admin.call("GET", "/v1/office/lines", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array().unwrap().clone()
}

/// The feed items a station gets after `since`.
async fn feed(admin: &Admin, since: i64) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes?since={since}")),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"].clone()
}

fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

#[tokio::test]
async fn an_administrator_creates_renames_and_archives_lines() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "  Линия 3  " })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created,
        json!({ "id": id, "name": "Линия 3", "archived": false, "rev": 2 })
    );
    assert_eq!(
        audit_trail(&admin.app, "line.create").await,
        vec![admin.row("line.create", "line", &id, json!({ "name": "Линия 3" }))]
    );
    // Stations get the new line.
    assert_eq!(
        feed(&admin, 1).await,
        json!([{ "entity": "lines", "id": id, "rev": 2, "deleted": false, "data": { "name": "Линия 3", "archived": false } }])
    );

    let path = format!("/v1/office/lines/{id}");
    let (status, renamed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Упаковка", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        renamed,
        json!({ "id": id, "name": "Упаковка", "archived": false, "rev": 3 })
    );
    let (status, archived) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(
        archived,
        json!({ "id": id, "name": "Упаковка", "archived": true, "rev": 4 })
    );
    assert_eq!(
        audit_trail(&admin.app, "line.update").await,
        vec![
            admin.row(
                "line.update",
                "line",
                &id,
                json!({ "changed": ["name"], "name": { "from": "Линия 3", "to": "Упаковка" } })
            ),
            admin.row(
                "line.update",
                "line",
                &id,
                json!({ "changed": ["archived"], "archived": { "from": false, "to": true } })
            ),
        ]
    );
    // An archived line stays in the feed and in the office list, marked.
    assert_eq!(
        feed(&admin, 3).await,
        json!([{ "entity": "lines", "id": id, "rev": 4, "deleted": false, "data": { "name": "Упаковка", "archived": true } }])
    );
    let listed: Vec<(Value, Value)> = lines(&admin)
        .await
        .iter()
        .map(|line| (line["name"].clone(), line["archived"].clone()))
        .collect();
    assert_eq!(
        listed,
        vec![
            (json!("Линия 1"), json!(false)),
            (json!("Линия 2"), json!(false)),
            (json!("Упаковка"), json!(true)),
        ]
    );

    // Nothing to change: no revision, no row.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": " Упаковка ", "archived": true, "expectedRev": 4 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, archived));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_trail(&admin.app, "line.update").await.len(), 2);
    // An old revision is refused.
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": false, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(4))
    );
}

#[tokio::test]
async fn line_names_are_unique_among_active_lines_regardless_of_case() {
    let admin = admin().await;
    let wizard = lines(&admin).await;
    let first = format!("/v1/office/lines/{}", wizard[0]["id"].as_str().unwrap());
    let second = format!("/v1/office/lines/{}", wizard[1]["id"].as_str().unwrap());

    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "ЛИНИЯ 1" })),
        )
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("line_name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            &second,
            Some(json!({ "name": "линия 1", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("line_name"))
    );
    assert_eq!(
        host_revision(&admin.app).await,
        1,
        "a refused write takes no revision"
    );

    // Once «Линия 1» is archived, its name is free...
    let (status, _) = admin
        .call(
            "PUT",
            &first,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, reused) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "линия 1" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{reused}");
    // ...and the archived line cannot come back while the name is taken.
    let (status, body) = admin
        .call(
            "PUT",
            &first,
            Some(json!({ "archived": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("line_name"))
    );
    assert_eq!(audit_trail(&admin.app, "line.create").await.len(), 1);
    assert_eq!(audit_trail(&admin.app, "line.update").await.len(), 1);
}

#[tokio::test]
async fn line_names_are_checked() {
    let admin = admin().await;
    for name in [" ".to_owned(), "л".repeat(101)] {
        let (status, body) = admin
            .call("POST", "/v1/office/lines", Some(json!({ "name": name })))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("name"))
        );
    }
    let path = format!(
        "/v1/office/lines/{}",
        lines(&admin).await[0]["id"].as_str().unwrap()
    );
    let (status, body) = admin
        .call("PUT", &path, Some(json!({ "name": "", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "rename": "Упаковка", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(audit_trail(&admin.app, "line.create").await.is_empty());
    assert!(audit_trail(&admin.app, "line.update").await.is_empty());
}

#[tokio::test]
async fn technologists_read_lines_but_do_not_change_them() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, list) = admin.call_as(&tech, "GET", "/v1/office/lines", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list, Value::Array(lines(&admin).await));
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "Линия 3" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let path = format!("/v1/office/lines/{}", list[0]["id"].as_str().unwrap());
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(audit_trail(&admin.app, "line.create").await.is_empty());
    assert!(audit_trail(&admin.app, "line.update").await.is_empty());
}

#[tokio::test]
async fn archiving_a_line_leaves_its_stations_on_it() {
    let admin = admin().await;
    let line = lines(&admin).await[0]["id"].as_str().unwrap().to_owned();
    let (status, _) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{line}"),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(device["lineId"], json!(line));
}

#[tokio::test]
async fn an_unknown_line_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/lines/9b2e4a6c-0000-4000-8000-000000000000";
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": " ", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}
```

2. Create `apps/standalone/proto/fixtures/office-line.json`:

```json
{ "id": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61", "name": "Линия 2", "archived": false, "rev": 40 }
```

3. Create `apps/standalone/proto/fixtures/line-create.json`:

```json
{ "name": "Линия 3" }
```

4. Create `apps/standalone/proto/fixtures/line-update.json`:

```json
{ "archived": true, "expectedRev": 40 }
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, ErrorBody, Hello, HelloEnvelope,
    LineRecord, LocalPairRequest, OfficeLoginRequest, OfficeRole, OfficeSession, OfficeUser,
    OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorRecord,
    OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange,
    PasswordSet, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, ErrorBody, Hello, HelloEnvelope,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorRecord, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PasswordChange, PasswordSet, SiteRecord, SsccCounterUpdate, SsccState,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn line_fixtures_round_trip_and_an_update_carries_only_what_changes() {
    let line: OfficeLine = round_trip("office-line.json");
    assert!(!line.archived);
    let create: LineCreate = round_trip("line-create.json");
    assert_eq!(create.name, "Линия 3");
    let update: LineUpdate = round_trip("line-update.json");
    assert_eq!((update.name, update.archived), (None, Some(true)));
    let mut value = fixture("line-update.json");
    value["rename"] = Value::Bool(true);
    assert!(serde_json::from_value::<LineUpdate>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test lines --offline`
Expected: FAIL — 6 тестов из 6: маршрутов ещё нет, и хост отвечает `404` там, где тесты ждут `200` или `400` (`left: 404`, `right: 200`; `left: (404, Null)`, `right: (400, String("name"))`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::LineCreate`, `markiro_proto::LineUpdate`, `markiro_proto::OfficeLine` ``.

- [ ] **Step 3: Записи протокола и маршруты линий**

1. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const COUNTERPARTY_UPDATE: &str = "counterparty.update";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const COUNTERPARTY_UPDATE: &str = "counterparty.update";
    pub const LINE_CREATE: &str = "line.create";
    pub const LINE_UPDATE: &str = "line.update";
}
```

2. В `apps/standalone/proto/src/lib.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
    pub gs1_prefixes: Vec<String>,
    pub archived: bool,
    pub expected_rev: i64,
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub gs1_prefixes: Vec<String>,
    pub archived: bool,
    pub expected_rev: i64,
}

/// A production line as the office sees it (`GET /v1/office/lines`,
/// archived lines included).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLine {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub rev: i64,
}

/// `POST /v1/office/lines`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineCreate {
    pub name: String,
}

/// `PUT /v1/office/lines/{id}`: only the fields sent change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub expected_rev: i64,
}
```

3. Create `apps/standalone/host/src/routes/lines.rs`:

```rust
//! Production lines: `GET /v1/office/lines` (every role, archived lines
//! included), `POST` and `PUT …/{id}` (administrators, `PUT` with
//! `expectedRev`). Lines ride the station feed, so a rename or an archive
//! takes a new revision. Archiving a line leaves the devices assigned to it
//! alone; a station cannot pick an archived line (`PUT /v1/device/line`).

use axum::extract::State;
use axum::Json;
use markiro_proto::{LineCreate, LineUpdate, OfficeLine};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

#[derive(sqlx::FromRow)]
struct LineRow {
    id: String,
    name: String,
    archived: bool,
    rev: i64,
}

impl From<LineRow> for OfficeLine {
    fn from(row: LineRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            archived: row.archived,
            rev: row.rev,
        }
    }
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeLine>, ApiError> {
    let row: Option<LineRow> =
        sqlx::query_as("SELECT id, name, archived, rev FROM lines WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(row.map(OfficeLine::from))
}

/// A write that hit `lines_active_name_key`: another active line already has
/// the name, compared without case.
fn name_taken(error: sqlx::Error) -> ApiError {
    match error.as_database_error() {
        Some(database) if database.is_unique_violation() => {
            ApiError::conflict("line_name", "another active line has this name")
        }
        _ => ApiError::internal(error),
    }
}

pub async fn list_lines(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<OfficeLine>>, ApiError> {
    let rows: Vec<LineRow> =
        sqlx::query_as("SELECT id, name, archived, rev FROM lines ORDER BY archived, name_key, id")
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(rows.into_iter().map(OfficeLine::from).collect()))
}

pub async fn create_line(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<LineCreate>,
) -> Result<Json<OfficeLine>, ApiError> {
    context.require_admin()?;
    let (name, name_key) = validate::line_name("name", &create.name)?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&name_key)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(name_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LINE_CREATE,
            target_type: Some("line"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("line vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_line(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<LineUpdate>,
) -> Result<Json<OfficeLine>, ApiError> {
    context.require_admin()?;
    let renamed = update
        .name
        .as_deref()
        .map(|name| validate::line_name("name", name))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such line"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let name = renamed
        .as_ref()
        .map_or(current.name.as_str(), |(name, _)| name.as_str());
    let archived = update.archived.unwrap_or(current.archived);
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("archived", json!(current.archived), json!(archived)),
    ]) else {
        // Nothing actually changed: report the line as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE lines SET name = COALESCE(?, name), name_key = COALESCE(?, name_key), \
         archived = ?, rev = ? WHERE id = ?",
    )
    .bind(renamed.as_ref().map(|(name, _)| name))
    .bind(renamed.as_ref().map(|(_, name_key)| name_key))
    .bind(archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(name_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LINE_UPDATE,
            target_type: Some("line"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("line vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

4. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod devices;
pub mod office_auth;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod devices;
pub mod lines;
pub mod office_auth;
```

5. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/counterparties/{id}",
            put(crate::routes::counterparties::update_counterparty),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/counterparties/{id}",
            put(crate::routes::counterparties::update_counterparty),
        )
        .route(
            "/v1/office/lines",
            get(crate::routes::lines::list_lines).post(crate::routes::lines::create_line),
        )
        .route(
            "/v1/office/lines/{id}",
            put(crate::routes::lines::update_line),
        )
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test lines --offline`
Expected: PASS — 6 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 23 теста.

- [ ] **Step 5: Документы**

1. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.3, фрагмент

<!-- prettier-ignore -->
```text
  регистра обеспечивает столбец `name_key` (обрезанное имя в нижнем регистре по
  Unicode, считает хост), потому что `lower()` SQLite складывает только ASCII.
```

заменить на

<!-- prettier-ignore -->
```text
  регистра обеспечивает столбец `name_key` (обрезанное имя в нижнем регистре по
  Unicode, считает хост), потому что `lower()` SQLite складывает только ASCII.
  Имя, занятое активной линией, — `conflict` с `constraint: line_name` при
  создании, переименовании и возврате из архива. Архивирование не трогает
  устройства на линии (план 1d2); выбрать архивную линию станция не может.
```

2. Там же, §4.5, фрагмент

<!-- prettier-ignore -->
```text
- контрагенты — `counterparty-record.json` (ответ), `counterparty-create.json`,
  `counterparty-update.json` (`PUT` — запись целиком с `archived` и `expectedRev`).
```

заменить на

<!-- prettier-ignore -->
```text
- контрагенты — `counterparty-record.json` (ответ), `counterparty-create.json`,
  `counterparty-update.json` (`PUT` — запись целиком с `archived` и `expectedRev`);
- линии — `office-line.json` (ответ, в списке и архивные), `line-create.json`,
  `line-update.json` (`PUT` меняет только присланные `name` и `archived`).
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/office-line.json apps/standalone/proto/fixtures/line-create.json apps/standalone/proto/fixtures/line-update.json docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

```bash
git add apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/lines.rs apps/standalone/host/tests/lines.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-line.json apps/standalone/proto/fixtures/line-create.json apps/standalone/proto/fixtures/line-update.json docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): линии в офисе хоста" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Операторы — потолок итераций PHC и `GET/POST/PUT /v1/office/operators`

Оператор входит на станции по табельному номеру и PIN или по бейджу. Хеш PIN считает офис функциями `@markiro/domain`; хост хранит строку PHC и никогда не видит PIN. Хост проверяет формат PHC и число итераций: от 10 000 до 1 000 000. Потолок стоит в `secrets::parse_phc` (отложено с плана 1b1): станция проверяет PIN с числом итераций из хеша, и хеш с миллиардом итераций остановил бы вход. Через тот же `parse_phc` идут и пароли офиса (600 000 итераций), так что поддельный хеш в базе не затянет и проверку пароля на хосте.

Раздел оператора только для администратора: технолог получает `forbidden` и на чтение. `GET` отдаёт `hasPin` и сведения о бейджах — `id`, `label`, `createdAt`, `revokedAt`, отозванные тоже, — но никогда не хеш. `PUT` меняет только присланные поля (`name?`, `role?`, `active?`, `pinPhc?`) и требует `expectedRev`; `role: null` очищает должность (отсутствие поля — оставить), для этого в `proto` появляется помощник `nullable`. Табельный номер не меняется.

Лента — по правилу задачи 1: выключение оператора пишет надгробие (`feed::remove`), повторное включение удаляет надгробие (`feed::restore`) и отдаёт запись с новой ревизией. Смена PIN — обновление записи с новым `pinPhc`. В журнал попадают имена изменённых полей и `{ from, to }` для имени, должности и активности; для PIN — только имя поля `pinPhc` (`audit::update_details_hiding`).

**Files:**

- Create: `apps/standalone/host/src/routes/operators.rs`, `apps/standalone/host/tests/operators.rs`
- Create: `apps/standalone/proto/fixtures/office-operator.json`, `operator-create.json`, `operator-update.json`
- Modify: `apps/standalone/host/src/{secrets,validate,audit,server}.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/proto/tests/fixtures.rs`
- Modify: спецификация §4.3, §4.5

**Interfaces:**

- Consumes:
  - `feed::{remove, restore}`, таблицы `operators`, `operator_badges` (задача 1);
  - `validate::person_name(field, name) -> Result<String, ApiError>`;
  - `Admin`, `admin`, `audit_trail`, `host_revision` (задача 2).
- Produces:
  - `pub const secrets::MIN_ITERATIONS: u32 = 10_000`, `pub const secrets::MAX_ITERATIONS: u32 = 1_000_000`; `parse_phc` отвергает число итераций вне этих границ;
  - `pub fn validate::operator_login(field, login) -> Result<(), ApiError>`, `pub fn validate::operator_role(field, role: Option<&str>) -> Result<Option<String>, ApiError>`, `pub fn validate::pin_phc(field, phc) -> Result<(), ApiError>`;
  - `pub fn audit::update_details_hiding(fields: &[(&str, Value, Value)], hidden: &[(&str, bool)]) -> Option<Value>`; `actions::OPERATOR_CREATE = "operator.create"`, `actions::OPERATOR_UPDATE = "operator.update"`;
  - `proto`: модуль `nullable` (serde для `Option<Option<T>>`), `BadgeInfo { id, label, created_at, revoked_at }`, `OfficeOperator { id, login, name, role, active, has_pin, badges, rev }`, `OperatorCreate { login, name, role, pin_phc: Secret }`, `OperatorUpdate { name, role: Option<Option<String>>, active, pin_phc: Option<Secret>, expected_rev }`;
  - в `routes/operators.rs` — `read_operator(conn, id) -> Result<Option<OfficeOperator>, ApiError>` и `badge(row) -> BadgeInfo`; маршруты бейджей задачи 5 живут в том же модуле.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/host/tests/operators.rs`:

```rust
mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{admin, audit_trail, empty, host_revision, request, with_device, Admin};

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_4821: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// A PIN verifier in the domain format: the host checks only its shape and
/// its iteration count, never which PIN it hides.
fn pin(iterations: u32, digest_byte: u8) -> String {
    format!(
        "pbkdf2$sha256${iterations}$bWFya2lyby1waW4tc2FsdA==${}",
        STANDARD.encode([digest_byte; 32])
    )
}

fn new_operator(login: &str) -> Value {
    json!({ "login": login, "name": " Анна Кузнецова ", "role": " Упаковщик ", "pinPhc": PIN_4821 })
}

fn field(body: &Value) -> Value {
    body["error"]["details"]["field"].clone()
}

/// The feed items a station gets after `since`.
async fn feed(admin: &Admin, since: i64) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes?since={since}")),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"].clone()
}

/// A new operator `0042`; returns its id.
async fn create(admin: &Admin) -> String {
    let (status, created) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("0042")))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn an_administrator_creates_an_operator_and_never_gets_a_hash_back() {
    let admin = admin().await;
    let (status, created) = admin
        .call("POST", "/v1/office/operators", Some(new_operator(" 0042 ")))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created,
        json!({
            "id": id, "login": "0042", "name": "Анна Кузнецова", "role": "Упаковщик",
            "active": true, "hasPin": true, "badges": [], "rev": 2
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "operator.create").await,
        vec![admin.row(
            "operator.create",
            "operator",
            &id,
            json!({ "login": "0042", "role": "Упаковщик" })
        )]
    );
    let (status, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!((status, list.clone()), (StatusCode::OK, json!([created])));
    assert!(
        !list.to_string().contains("pbkdf2"),
        "the office never gets a hash back"
    );
    // The station gets the operator with the PIN hash.
    assert_eq!(
        feed(&admin, 1).await,
        json!([{
            "entity": "operators", "id": id, "rev": 2, "deleted": false,
            "data": { "login": "0042", "name": "Анна Кузнецова", "role": "Упаковщик", "pinPhc": PIN_4821 }
        }])
    );
}

#[tokio::test]
async fn operator_fields_are_checked() {
    let admin = admin().await;
    for login in ["12", "1234567890123", "12a4", "٠١٢٣"] {
        let (status, body) = admin
            .call("POST", "/v1/office/operators", Some(new_operator(login)))
            .await;
        assert_eq!(
            (status, field(&body)),
            (StatusCode::BAD_REQUEST, json!("login")),
            "{login}"
        );
    }
    let mut blank_name = new_operator("0042");
    blank_name["name"] = json!(" ");
    let mut long_role = new_operator("0042");
    long_role["role"] = json!("м".repeat(121));
    for (body, expected) in [(blank_name, "name"), (long_role, "role")] {
        let (status, error) = admin.call("POST", "/v1/office/operators", Some(body)).await;
        assert_eq!(
            (status, field(&error)),
            (StatusCode::BAD_REQUEST, json!(expected))
        );
    }
    let mut raw_pin = new_operator("0042");
    raw_pin["pin"] = json!("4821");
    let (status, error) = admin
        .call("POST", "/v1/office/operators", Some(raw_pin))
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(audit_trail(&admin.app, "operator.create").await.is_empty());

    // A blank role is no role.
    let mut blank_role = new_operator("0042");
    blank_role["role"] = json!("  ");
    let (status, created) = admin
        .call("POST", "/v1/office/operators", Some(blank_role))
        .await;
    assert_eq!(
        (status, created["role"].clone()),
        (StatusCode::OK, Value::Null)
    );
}

#[tokio::test]
async fn pin_hashes_must_be_domain_phc_strings_within_the_iteration_bounds() {
    let admin = admin().await;
    for pin_phc in [
        "4821".to_owned(),
        pin(9_999, 1),
        pin(1_000_001, 1),
        PIN_4821.replace("==", "="),
        format!("{PIN_4821}$x"),
    ] {
        let mut body = new_operator("0042");
        body["pinPhc"] = json!(pin_phc);
        let (status, error) = admin.call("POST", "/v1/office/operators", Some(body)).await;
        assert_eq!(
            (status, field(&error)),
            (StatusCode::BAD_REQUEST, json!("pinPhc")),
            "{pin_phc}"
        );
    }
    let mut body = new_operator("0042");
    body["pinPhc"] = json!(pin(1_000_000, 1));
    let (status, created) = admin.call("POST", "/v1/office/operators", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // A new PIN meets the same bounds.
    let (status, error) = admin
        .call(
            "PUT",
            &format!("/v1/office/operators/{}", created["id"].as_str().unwrap()),
            Some(json!({ "pinPhc": pin(1_000_001, 2), "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, field(&error)),
        (StatusCode::BAD_REQUEST, json!("pinPhc"))
    );
}

#[tokio::test]
async fn personnel_numbers_are_unique_with_their_leading_zeros() {
    let admin = admin().await;
    create(&admin).await;
    let (status, body) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("0042")))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("login"))
    );
    assert_eq!(host_revision(&admin.app).await, 2);
    // Leading zeros are part of the number: 042 is another operator.
    let (status, other) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("042")))
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    assert_eq!(audit_trail(&admin.app, "operator.create").await.len(), 2);
}

#[tokio::test]
async fn an_update_names_the_changed_fields_and_never_the_pin_hash() {
    let admin = admin().await;
    let id = create(&admin).await;
    let path = format!("/v1/office/operators/{id}");
    let new_pin = pin(100_000, 7);
    let (status, updated) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Анна Петрова", "role": null, "pinPhc": new_pin, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        updated,
        json!({
            "id": id, "login": "0042", "name": "Анна Петрова", "role": null,
            "active": true, "hasPin": true, "badges": [], "rev": 3
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "operator.update").await,
        vec![admin.row(
            "operator.update",
            "operator",
            &id,
            json!({
                "changed": ["name", "role", "pinPhc"],
                "name": { "from": "Анна Кузнецова", "to": "Анна Петрова" },
                "role": { "from": "Упаковщик", "to": null }
            })
        )]
    );
    // The station replaces the hash, so the old PIN stops working there.
    assert_eq!(
        feed(&admin, 2).await,
        json!([{
            "entity": "operators", "id": id, "rev": 3, "deleted": false,
            "data": { "login": "0042", "name": "Анна Петрова", "role": null, "pinPhc": new_pin }
        }])
    );

    // An absent field keeps its value; the same values change nothing.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Анна Петрова", "pinPhc": new_pin, "expectedRev": 3 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, updated));
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_trail(&admin.app, "operator.update").await.len(), 1);
    // An old revision is refused.
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "role": "Мастер", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(3))
    );
}

#[tokio::test]
async fn deactivation_sends_a_tombstone_and_reactivation_the_record_again() {
    let admin = admin().await;
    let id = create(&admin).await;
    let path = format!("/v1/office/operators/{id}");
    let (status, off) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "active": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, off["active"].clone(), off["rev"].clone()),
        (StatusCode::OK, json!(false), json!(3))
    );
    let gone = json!([{ "entity": "operators", "id": id, "rev": 3, "deleted": true }]);
    assert_eq!(feed(&admin, 2).await, gone);
    // A station syncing from zero never gets the record.
    assert_eq!(feed(&admin, 1).await, gone);
    // The office still lists the operator, inactive.
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(list, json!([off]));

    let (status, on) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "active": true, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (status, on["active"].clone(), on["rev"].clone()),
        (StatusCode::OK, json!(true), json!(4))
    );
    let back = json!([{
        "entity": "operators", "id": id, "rev": 4, "deleted": false,
        "data": { "login": "0042", "name": "Анна Кузнецова", "role": "Упаковщик", "pinPhc": PIN_4821 }
    }]);
    assert_eq!(feed(&admin, 3).await, back);
    assert_eq!(feed(&admin, 1).await, back, "the tombstone is gone");
    assert_eq!(
        audit_trail(&admin.app, "operator.update").await,
        vec![
            admin.row(
                "operator.update",
                "operator",
                &id,
                json!({ "changed": ["active"], "active": { "from": true, "to": false } })
            ),
            admin.row(
                "operator.update",
                "operator",
                &id,
                json!({ "changed": ["active"], "active": { "from": false, "to": true } })
            ),
        ]
    );
}

#[tokio::test]
async fn technologists_have_no_access_to_operators() {
    let admin = admin().await;
    let id = create(&admin).await;
    let tech = admin.technologist().await;
    for (method, path, body) in [
        ("GET", "/v1/office/operators".to_owned(), None),
        (
            "POST",
            "/v1/office/operators".to_owned(),
            Some(new_operator("0043")),
        ),
        (
            "PUT",
            format!("/v1/office/operators/{id}"),
            Some(json!({ "active": false, "expectedRev": 2 })),
        ),
    ] {
        let (status, error) = admin.call_as(&tech, method, &path, body).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method} {path}"
        );
    }
    assert_eq!(audit_trail(&admin.app, "operator.create").await.len(), 1);
    assert!(audit_trail(&admin.app, "operator.update").await.is_empty());
}

#[tokio::test]
async fn an_unknown_operator_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/operators/9b2e4a6c-0000-4000-8000-000000000000";
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": " ", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, field(&body)),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "active": false, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}
```

2. Create `apps/standalone/proto/fixtures/office-operator.json`:

```json
{
  "id": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  "login": "0042",
  "name": "Анна Кузнецова",
  "role": null,
  "active": true,
  "hasPin": true,
  "badges": [
    {
      "id": "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      "label": "Пропуск №7",
      "createdAt": "2026-09-27T08:00:00Z",
      "revokedAt": null
    },
    {
      "id": "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
      "label": null,
      "createdAt": "2026-09-20T08:00:00Z",
      "revokedAt": "2026-09-27T08:00:00Z"
    }
  ],
  "rev": 55
}
```

3. Create `apps/standalone/proto/fixtures/operator-create.json`:

```json
{
  "login": "0042",
  "name": "Анна Кузнецова",
  "role": "Упаковщик",
  "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
}
```

4. Create `apps/standalone/proto/fixtures/operator-update.json`:

```json
{
  "role": null,
  "active": false,
  "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
  "expectedRev": 55
}
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, ErrorBody, Hello, HelloEnvelope,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorRecord, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PasswordChange, PasswordSet, SiteRecord, SsccCounterUpdate, SsccState,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, ErrorBody, Hello, HelloEnvelope,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord,
    OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate,
    OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange,
    PasswordSet, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn operator_fixtures_round_trip_without_leaking_the_pin_hash() {
    let operator: OfficeOperator = round_trip("office-operator.json");
    assert!(operator.has_pin);
    assert_eq!(
        operator.badges[1].revoked_at.as_deref(),
        Some("2026-09-27T08:00:00Z")
    );
    let create: OperatorCreate = round_trip("operator-create.json");
    let update: OperatorUpdate = round_trip("operator-update.json");
    // `role: null` clears the role; an absent role keeps it.
    assert_eq!(
        (update.name.clone(), update.role.clone()),
        (None, Some(None))
    );
    let absent: OperatorUpdate =
        serde_json::from_value(serde_json::json!({ "expectedRev": 55 })).unwrap();
    assert_eq!(absent.role, None);
    assert_eq!(
        serde_json::to_value(&absent).unwrap(),
        serde_json::json!({ "expectedRev": 55 })
    );
    let debug = format!("{create:?} {update:?}");
    assert!(!debug.contains("pbkdf2"), "{debug}");
    // A raw PIN is not a field, and the personnel number never changes.
    let mut value = fixture("operator-create.json");
    value["pin"] = Value::String("4821".into());
    assert!(serde_json::from_value::<OperatorCreate>(value).is_err());
    let mut value = fixture("operator-update.json");
    value["login"] = Value::String("0043".into());
    assert!(serde_json::from_value::<OperatorUpdate>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
```

7. В `apps/standalone/host/src/secrets.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[test]
    fn malformed_verifiers_never_match() {
        for bad in [
            "pbkdf2$sha256$9999$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
```

заменить на

<!-- prettier-ignore -->
```rust
    #[test]
    fn the_iteration_count_is_bounded_on_both_sides() {
        let phc = |iterations: u32| {
            format!("pbkdf2$sha256${iterations}$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=")
        };
        let iterations = |iterations: u32| parse_phc(&phc(iterations)).map(|phc| phc.iterations);
        assert_eq!(iterations(10_000), Some(10_000));
        assert_eq!(iterations(1_000_000), Some(1_000_000));
        assert_eq!(iterations(9_999), None);
        assert_eq!(iterations(1_000_001), None);
        assert_eq!(iterations(u32::MAX), None);
    }

    #[test]
    fn malformed_verifiers_never_match() {
        for bad in [
            "pbkdf2$sha256$9999$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$1000001$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
```

8. В `apps/standalone/host/src/validate.rs`, в модуле `tests`, фрагмент

<!-- prettier-ignore -->
```rust
        let eleven: Vec<String> = (0..11).map(|n| format!("46012{n:02}")).collect();
        assert_eq!(
            field(company("", "Берег", None, GLN, &eleven)),
            "gs1Prefixes"
        );
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        let eleven: Vec<String> = (0..11).map(|n| format!("46012{n:02}")).collect();
        assert_eq!(
            field(company("", "Берег", None, GLN, &eleven)),
            "gs1Prefixes"
        );
    }

    #[test]
    fn a_personnel_number_is_3_to_12_ascii_digits() {
        for login in ["042", "0042", "123456789012"] {
            assert!(operator_login("login", login).is_ok(), "{login}");
        }
        for login in ["42", "1234567890123", "12a4", "٠١٢٣", " 0042", ""] {
            assert_eq!(field(operator_login("login", login)), "login", "{login:?}");
        }
    }

    #[test]
    fn a_role_is_optional_trimmed_text_of_at_most_120_characters() {
        assert_eq!(operator_role("role", None).unwrap(), None);
        assert_eq!(operator_role("role", Some("  ")).unwrap(), None);
        assert_eq!(
            operator_role("role", Some(" Упаковщик "))
                .unwrap()
                .as_deref(),
            Some("Упаковщик")
        );
        assert!(operator_role("role", Some(&"м".repeat(120))).is_ok());
        assert_eq!(field(operator_role("role", Some(&"м".repeat(121)))), "role");
    }

    #[test]
    fn a_pin_hash_is_a_domain_phc_string_within_the_iteration_bounds() {
        let phc = |iterations: u32| {
            format!("pbkdf2$sha256${iterations}$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=")
        };
        assert!(pin_phc("pinPhc", &phc(100_000)).is_ok());
        assert!(pin_phc("pinPhc", &phc(1_000_000)).is_ok());
        for bad in [phc(9_999), phc(1_000_001), "4821".to_owned(), String::new()] {
            assert_eq!(field(pin_phc("pinPhc", &bad)), "pinPhc", "{bad}");
        }
    }
}
```

9. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    use super::update_details;
```

заменить на

<!-- prettier-ignore -->
```rust
    use super::{update_details, update_details_hiding};

    #[test]
    fn hidden_fields_are_named_without_their_values() {
        assert_eq!(
            update_details_hiding(
                &[("name", json!("Анна"), json!("Анна Петрова"))],
                &[("pinPhc", true)]
            ),
            Some(json!({
                "changed": ["name", "pinPhc"],
                "name": { "from": "Анна", "to": "Анна Петрова" },
            }))
        );
        assert_eq!(
            update_details_hiding(&[], &[("pinPhc", true)]),
            Some(json!({ "changed": ["pinPhc"] }))
        );
        assert_eq!(
            update_details_hiding(
                &[("name", json!("Анна"), json!("Анна"))],
                &[("pinPhc", false)]
            ),
            None
        );
    }
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline`
Expected: FAIL — 8 тестов из 8: маршрутов ещё нет, хост отвечает `404` там, где тесты ждут `200`, `400` или `403`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
Expected: FAIL — не компилируется: `error[E0425]` — нет `operator_login`, `operator_role` и `pin_phc`, `error[E0432]` — нет `update_details_hiding`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::OfficeOperator`, `markiro_proto::OperatorCreate`, `markiro_proto::OperatorUpdate` ``.

- [ ] **Step 3: Потолок итераций, проверки, записи протокола и маршруты операторов**

1. В `apps/standalone/host/src/secrets.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// The domain's floor: a tampered verifier must not cheapen the work.
const MIN_ITERATIONS: u32 = 10_000;
```

заменить на

<!-- prettier-ignore -->
```rust
/// The domain's floor: a tampered verifier must not cheapen the work.
pub const MIN_ITERATIONS: u32 = 10_000;
/// The ceiling. A station verifies a PIN or a badge with the count its hash
/// carries, so more work than this could stall a sign-in; ten times the
/// domain's 100 000 leaves room to raise the default, and office passwords
/// (600 000) fit under it too.
pub const MAX_ITERATIONS: u32 = 1_000_000;
```

2. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// base64 with padding, a 16-byte salt and a 32-byte digest. Stricter than
/// `parsePhc` on the iteration count, which must be plain ASCII digits.
```

заменить на

<!-- prettier-ignore -->
```rust
/// base64 with padding, a 16-byte salt and a 32-byte digest. Stricter than
/// `parsePhc` on the iteration count, which must be plain ASCII digits
/// within `MIN_ITERATIONS..=MAX_ITERATIONS`.
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
    if iterations < MIN_ITERATIONS {
        return None;
    }
```

заменить на

<!-- prettier-ignore -->
```rust
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return None;
    }
```

4. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// A password: 8-128 characters (the upper bound keeps PBKDF2 input small).
```

заменить на

<!-- prettier-ignore -->
```rust
/// An operator's personnel number: 3-12 ASCII digits, as in the cloud
/// (`apps/api/src/modules/operators/dto.ts`). Leading zeros are part of it.
pub fn operator_login(field: &str, login: &str) -> Result<(), ApiError> {
    if (3..=12).contains(&login.len()) && login.bytes().all(|byte| byte.is_ascii_digit()) {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "the personnel number must be 3-12 digits",
        ))
    }
}

/// Optional free text: trimmed, blank is none, at most `max` characters.
fn optional_text(field: &str, text: Option<&str>, max: usize) -> Result<Option<String>, ApiError> {
    match text.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) if text.chars().count() <= max => Ok(Some(text.to_owned())),
        Some(_) => Err(ApiError::validation(
            field,
            format!("at most {max} characters"),
        )),
    }
}

/// An operator's role: free text like the cloud's employee role (at most
/// 120 characters), or none.
pub fn operator_role(field: &str, role: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, role, 120)
}

/// A PIN verifier the office computed: a PHC string in the `@markiro/domain`
/// format with `secrets::MIN_ITERATIONS..=secrets::MAX_ITERATIONS`
/// iterations. The host never sees the PIN, so this is all it can check.
pub fn pin_phc(field: &str, phc: &str) -> Result<(), ApiError> {
    if crate::secrets::parse_phc(phc).is_some() {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "a PBKDF2 PHC string with 10000-1000000 iterations is required",
        ))
    }
}

/// A password: 8-128 characters (the upper bound keeps PBKDF2 input small).
```

5. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const LINE_UPDATE: &str = "line.update";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const LINE_UPDATE: &str = "line.update";
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
}
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
pub fn update_details(fields: &[(&str, Value, Value)]) -> Option<Value> {
    update_details_hiding(fields, &[])
}

/// [`update_details`] plus fields whose values never enter the log (a PIN
/// hash): a changed one is named in `changed`, after the others, and has no
/// `{ from, to }`.
pub fn update_details_hiding(
    fields: &[(&str, Value, Value)],
    hidden: &[(&str, bool)],
) -> Option<Value> {
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
    for (name, did_change) in hidden {
        if *did_change {
            changed.push(Value::String((*name).to_owned()));
        }
    }
    if changed.is_empty() {
```

7. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod pairing;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod pairing;

/// Serde for a field of a partial update that may be absent (keep the stored
/// value), `null` (clear it) or a value (set it): an `Option<Option<T>>` with
/// `#[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]`.
/// Plain serde reads `null` as an absent field.
pub mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}
```

8. Там же, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
/// `PUT /v1/office/lines/{id}`: only the fields sent change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub expected_rev: i64,
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// `PUT /v1/office/lines/{id}`: only the fields sent change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub expected_rev: i64,
}

/// A badge as the administrator sees it: never its hash. Revoked badges are
/// listed too, with `revoked_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeInfo {
    pub id: String,
    pub label: Option<String>,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// An operator as the administrator sees it (`GET /v1/office/operators`):
/// never a hash, only whether a PIN is set and the badges' metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeOperator {
    pub id: String,
    /// Personnel number: 3-12 digits; it never changes.
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    pub active: bool,
    pub has_pin: bool,
    pub badges: Vec<BadgeInfo>,
    pub rev: i64,
}

/// `POST /v1/office/operators`: the office computed `pin_phc` from the PIN
/// with `@markiro/domain`; the host never sees the PIN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorCreate {
    pub login: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    pub pin_phc: Secret,
}

/// `PUT /v1/office/operators/{id}`: only the fields sent change; `role:
/// null` clears the role, and a new `pin_phc` replaces the PIN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub role: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_phc: Option<Secret>,
    pub expected_rev: i64,
}
```

9. Create `apps/standalone/host/src/routes/operators.rs`:

```rust
//! Operators (spec §4.3), administrators only: `GET /v1/office/operators`,
//! `POST` and `PUT …/{id}` (`PUT` with `expectedRev`). The office computes
//! the PIN's PHC string with `@markiro/domain`; the host checks its format
//! and never returns a hash (`hasPin` instead). An operator is in the station
//! feed only while active: a deactivation writes a tombstone and a
//! reactivation drops it (`feed`).

use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::{entities, BadgeInfo, OfficeOperator, OperatorCreate, OperatorUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::feed;
use crate::server::AppState;
use crate::validate;

const OPERATORS: &str =
    "SELECT id, login, name, role, active, pin_phc IS NOT NULL AS has_pin, rev FROM operators";
const BADGES: &str = "SELECT id, operator_id, label, created_at, revoked_at FROM operator_badges";

#[derive(sqlx::FromRow)]
struct OperatorRow {
    id: String,
    login: String,
    name: String,
    role: Option<String>,
    active: bool,
    has_pin: bool,
    rev: i64,
}

#[derive(sqlx::FromRow)]
struct BadgeRow {
    id: String,
    operator_id: String,
    label: Option<String>,
    created_at: String,
    revoked_at: Option<String>,
}

fn operator(row: OperatorRow, badges: Vec<BadgeInfo>) -> OfficeOperator {
    OfficeOperator {
        id: row.id,
        login: row.login,
        name: row.name,
        role: row.role,
        active: row.active,
        has_pin: row.has_pin,
        badges,
        rev: row.rev,
    }
}

fn badge(row: BadgeRow) -> BadgeInfo {
    BadgeInfo {
        id: row.id,
        label: row.label,
        created_at: row.created_at,
        revoked_at: row.revoked_at,
    }
}

/// One operator with its badges, oldest first.
async fn read_operator(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficeOperator>, ApiError> {
    let row: Option<OperatorRow> = sqlx::query_as(&format!("{OPERATORS} WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let badges: Vec<BadgeRow> = sqlx::query_as(&format!(
        "{BADGES} WHERE operator_id = ? ORDER BY created_at, id"
    ))
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Some(operator(row, badges.into_iter().map(badge).collect())))
}

/// A write that hit `operators.login UNIQUE`.
fn login_taken(error: sqlx::Error) -> ApiError {
    match error.as_database_error() {
        Some(database) if database.is_unique_violation() => {
            ApiError::conflict("login", "this personnel number is already taken")
        }
        _ => ApiError::internal(error),
    }
}

pub async fn list_operators(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<OfficeOperator>>, ApiError> {
    context.require_admin()?;
    // One read transaction: the operators and their badges come from one WAL
    // snapshot, so a badge added in between cannot miss its operator.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows: Vec<OperatorRow> = sqlx::query_as(&format!("{OPERATORS} ORDER BY login"))
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let badge_rows: Vec<BadgeRow> = sqlx::query_as(&format!("{BADGES} ORDER BY created_at, id"))
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let mut badges: HashMap<String, Vec<BadgeInfo>> = HashMap::new();
    for row in badge_rows {
        badges
            .entry(row.operator_id.clone())
            .or_default()
            .push(badge(row));
    }
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let own = badges.remove(&row.id).unwrap_or_default();
                operator(row, own)
            })
            .collect(),
    ))
}

pub async fn create_operator(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<OperatorCreate>,
) -> Result<Json<OfficeOperator>, ApiError> {
    context.require_admin()?;
    let login = create.login.trim().to_owned();
    validate::operator_login("login", &login)?;
    let name = validate::person_name("name", &create.name)?;
    let role = validate::operator_role("role", create.role.as_deref())?;
    validate::pin_phc("pinPhc", create.pin_phc.expose())?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
         VALUES (?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(&id)
    .bind(&login)
    .bind(&name)
    .bind(&role)
    .bind(create.pin_phc.expose())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(login_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_CREATE,
            target_type: Some("operator"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "login": login, "role": role }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("operator vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_operator(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<OperatorUpdate>,
) -> Result<Json<OfficeOperator>, ApiError> {
    context.require_admin()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::person_name("name", name))
        .transpose()?;
    let role = update
        .role
        .as_ref()
        .map(|role| validate::operator_role("role", role.as_deref()))
        .transpose()?;
    if let Some(pin_phc) = &update.pin_phc {
        validate::pin_phc("pinPhc", pin_phc.expose())?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such operator"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let current_pin: String = sqlx::query_scalar("SELECT pin_phc FROM operators WHERE id = ?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let name = name.unwrap_or_else(|| current.name.clone());
    let role = role.unwrap_or_else(|| current.role.clone());
    let active = update.active.unwrap_or(current.active);
    let pin_phc = update
        .pin_phc
        .as_ref()
        .map_or(current_pin.as_str(), |pin_phc| pin_phc.expose());
    let Some(details) = audit::update_details_hiding(
        &[
            ("name", json!(current.name), json!(name)),
            ("role", json!(current.role), json!(role)),
            ("active", json!(current.active), json!(active)),
        ],
        &[("pinPhc", pin_phc != current_pin)],
    ) else {
        // Nothing actually changed: report the operator as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE operators SET name = ?, role = ?, active = ?, pin_phc = ?, rev = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(&role)
    .bind(active)
    .bind(pin_phc)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    // Access leaves the station feed as a tombstone and comes back as a record
    // (spec §4.4), never as a flag on the record.
    match (current.active, active) {
        (true, false) => feed::remove(&mut tx, entities::OPERATORS, &id, rev).await,
        (false, true) => feed::restore(&mut tx, entities::OPERATORS, &id).await,
        _ => Ok(()),
    }
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_UPDATE,
            target_type: Some("operator"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("operator vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

10. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod office_users;
pub mod org;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod office_users;
pub mod operators;
pub mod org;
```

11. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/lines/{id}",
            put(crate::routes::lines::update_line),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/lines/{id}",
            put(crate::routes::lines::update_line),
        )
        .route(
            "/v1/office/operators",
            get(crate::routes::operators::list_operators)
                .post(crate::routes::operators::create_operator),
        )
        .route(
            "/v1/office/operators/{id}",
            put(crate::routes::operators::update_operator),
        )
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline`
Expected: PASS — 8 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
Expected: PASS — 23 теста: 18 прежних и новые `secrets::tests::the_iteration_count_is_bounded_on_both_sides`, три теста `validate::tests` и `audit::tests::hidden_fields_are_named_without_their_values`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --test office_admin --offline`
Expected: PASS — 16 и 8 тестов: пароли офиса (600 000 итераций) проходят под потолок.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 24 теста.

- [ ] **Step 5: Документы**

1. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.3, фрагмент

<!-- prettier-ignore -->
```text
- `operators(id, login UNIQUE, name, role, pin_phc, active, rev)`. Табельный номер —
  3–12 цифр, как в облаке (`apps/api/src/modules/operators/dto.ts`); это проверяет
  хост. PIN — 4–6 цифр; его проверяет интерфейс до расчёта хеша, хост видит только
  хеш и проверяет формат PHC.
```

заменить на

<!-- prettier-ignore -->
```text
- `operators(id, login UNIQUE, name, role, pin_phc, active, rev)`. Табельный номер —
  3–12 цифр, как в облаке (`apps/api/src/modules/operators/dto.ts`); это проверяет
  хост, повтор — `conflict` с `constraint: login`, ведущие нули — часть номера, и
  номер не меняется. PIN — 4–6 цифр; его проверяет интерфейс до расчёта хеша, хост
  видит только хеш и проверяет формат PHC и число итераций — от 10 000 до
  1 000 000: станция проверяет PIN с числом итераций из хеша, и потолок не даёт
  затянуть вход. Должность (`role`) — свободный текст до 120 символов или пусто,
  как в облаке. Офис хеша не получает: только `hasPin` и сведения о бейджах.
```

2. Там же, §4.5, фрагмент

<!-- prettier-ignore -->
```text
- линии — `office-line.json` (ответ, в списке и архивные), `line-create.json`,
  `line-update.json` (`PUT` меняет только присланные `name` и `archived`).
```

заменить на

<!-- prettier-ignore -->
```text
- линии — `office-line.json` (ответ, в списке и архивные), `line-create.json`,
  `line-update.json` (`PUT` меняет только присланные `name` и `archived`);
- операторы — `office-operator.json` (ответ: `hasPin` и бейджи без хешей),
  `operator-create.json`, `operator-update.json` (`PUT` меняет только присланные
  поля; `role: null` очищает должность, её отсутствие — оставляет).
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/office-operator.json apps/standalone/proto/fixtures/operator-create.json apps/standalone/proto/fixtures/operator-update.json docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

```bash
git add apps/standalone/host/src/secrets.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/operators.rs apps/standalone/host/tests/operators.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-operator.json apps/standalone/proto/fixtures/operator-create.json apps/standalone/proto/fixtures/operator-update.json docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): операторы на хосте, потолок итераций PHC" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Бейджи и соль бейджей — `POST/DELETE /v1/office/operators/{id}/badges…`, `GET /v1/office/badge-salt`

Хеш бейджа, как и PIN, считает офис: `deriveDigestB64(code, salt, PHC_ITERATIONS)` из `@markiro/domain`. Облако делает то же (`hashBadgeWithSalt` в `apps/api/src/lib/badge-salt.ts`): одна соль на площадку и ровно `PHC_ITERATIONS` = 100 000 итераций. Станция проверяет бейдж с солью и числом итераций из самого хеша (`verifyBadge` в `apps/station/src/lib/crypto.ts`), так что такой хеш она принимает без изменений. Хост требует у хеша бейджа соль площадки (`site.badge_salt`) и ровно 100 000 итераций. Тогда один код бейджа всегда даёт одну строку, и частичный индекс `operator_badges_active_phc` не даёт отдать бейдж второму оператору (`conflict` с `constraint: badge`). С другим числом итераций та же карта проскочила бы мимо индекса — поэтому число фиксировано, а не просто ограничено, как у PIN.

Офис берёт соль из `GET /v1/office/badge-salt`: это то же значение, что `badgeSalt` записи `site` в ленте. Бейдж получает `label` (до 100 символов или пусто) и отдаётся офису без хеша — `BadgeInfo`. `DELETE` — отзыв: `revoked_at`, новая ревизия и надгробие (`feed::remove`), ответ 204. Отозванный бейдж не возвращается; повторный отзыв ничего не меняет — ни ревизии, ни строки журнала. Бейдж ищется только под своим оператором: чужой или неизвестный — `not_found`. Добавление бейджа не меняет `rev` оператора: бейдж — своя сущность ленты.

Журнал процесса не должен видеть ни хеш PIN, ни хеш бейджа, ни соль: тест `no_secrets_in_logs.rs` проходит путь оператора и бейджа целиком и ищет их в журнале. Новых строк журнала задача не добавляет; тест закрывает пути, которые могли бы напечатать тело запроса.

**Files:**

- Create: `apps/standalone/host/tests/badges.rs`, `apps/standalone/proto/fixtures/badge-create.json`, `badge-salt.json`
- Modify: `apps/standalone/host/src/{secrets,validate,audit,server}.rs`, `apps/standalone/host/src/routes/operators.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` (новый раздел «Operators and badges»), спецификация §4.3, §4.5

**Interfaces:**

- Consumes:
  - `read_operator`, `badge`, `feed::remove`, `entities::OPERATOR_BADGES` (задачи 1 и 4);
  - `secrets::parse_phc`, `validate::optional_text` (задача 4);
  - `Admin`, `admin`, `audit_trail`, `host_revision` (задача 2).
- Produces:
  - `pub const secrets::BADGE_ITERATIONS: u32 = 100_000`, `pub fn Phc::salt(&self) -> &[u8]`;
  - `pub fn validate::badge_label(field, label: Option<&str>) -> Result<Option<String>, ApiError>`, `pub fn validate::badge_phc(field, phc, site_salt: &[u8]) -> Result<(), ApiError>`;
  - `actions::OPERATOR_BADGE_CREATE = "operator_badge.create"`, `actions::OPERATOR_BADGE_REVOKE = "operator_badge.revoke"`;
  - `BadgeCreate { badge_phc: Secret, label: Option<String> }`, `BadgeSalt { badge_salt: Secret }` — `proto/src/lib.rs`;
  - маршруты `POST /v1/office/operators/{id}/badges` → `BadgeInfo`, `DELETE /v1/office/operators/{id}/badges/{badge_id}` → 204, `GET /v1/office/badge-salt` → `BadgeSalt`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/host/tests/badges.rs`:

```rust
mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{admin, audit_trail, empty, host_revision, request, with_device, Admin};

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_4821: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// The site's badge salt, as the office reads it.
async fn site_salt(admin: &Admin) -> String {
    let (status, body) = admin.call("GET", "/v1/office/badge-salt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["badgeSalt"].as_str().unwrap().to_owned()
}

/// A badge verifier with `salt` and `iterations`: the host checks both,
/// never the code behind it.
fn badge(salt: &str, iterations: u32, digest_byte: u8) -> String {
    format!(
        "pbkdf2$sha256${iterations}${salt}${}",
        STANDARD.encode([digest_byte; 32])
    )
}

/// A new operator with `login`; returns its id.
async fn operator(admin: &Admin, login: &str) -> String {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/operators",
            Some(json!({ "login": login, "name": "Анна Кузнецова", "pinPhc": PIN_4821 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

/// The feed items a station gets after `since`.
async fn feed(admin: &Admin, since: i64) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes?since={since}")),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"].clone()
}

#[tokio::test]
async fn the_badge_salt_is_the_sites_and_only_for_administrators() {
    let admin = admin().await;
    let stored: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(site_salt(&admin).await, STANDARD.encode(&stored));
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/badge-salt", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

#[tokio::test]
async fn a_badge_hashed_with_the_site_salt_is_added_and_rides_the_feed() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let badge_phc = badge(&salt, 100_000, 1);
    let (status, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge_phc, "label": " Пропуск №7 " })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let badge_id = added["id"].as_str().unwrap().to_owned();
    assert_eq!(
        added,
        json!({
            "id": badge_id, "label": "Пропуск №7",
            "createdAt": admin.app.state.timestamp(), "revokedAt": null
        })
    );
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.create").await,
        vec![admin.row(
            "operator_badge.create",
            "operator_badge",
            &badge_id,
            json!({ "operatorId": id, "label": "Пропуск №7" })
        )]
    );
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(list[0]["badges"], json!([added]));
    assert_eq!(list[0]["rev"], json!(2), "a badge is its own feed record");
    assert!(!list.to_string().contains("pbkdf2"));
    assert_eq!(
        feed(&admin, 2).await,
        json!([{
            "entity": "operator_badges", "id": badge_id, "rev": 3, "deleted": false,
            "data": { "operatorId": id, "badgePhc": badge_phc, "label": "Пропуск №7" }
        }])
    );
}

#[tokio::test]
async fn a_badge_hash_must_carry_the_site_salt_and_the_domain_iterations() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let path = format!("/v1/office/operators/{id}/badges");
    for badge_phc in [
        badge(&salt, 200_000, 1),
        badge(&salt, 10_000, 1),
        badge("bWFya2lyby1waW4tc2FsdA==", 100_000, 1),
        "MRK-000742".to_owned(),
    ] {
        let (status, body) = admin
            .call("POST", &path, Some(json!({ "badgePhc": badge_phc })))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("badgePhc")),
            "{badge_phc}"
        );
    }
    let (status, body) = admin
        .call(
            "POST",
            &path,
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1), "label": "п".repeat(101) })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("label"))
    );
    assert!(audit_trail(&admin.app, "operator_badge.create")
        .await
        .is_empty());
    // A blank label is no label.
    let (status, added) = admin
        .call(
            "POST",
            &path,
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1), "label": "  " })),
        )
        .await;
    assert_eq!(
        (status, added["label"].clone()),
        (StatusCode::OK, Value::Null)
    );
}

#[tokio::test]
async fn one_badge_code_belongs_to_one_operator_at_a_time() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let first = operator(&admin, "0042").await;
    let second = operator(&admin, "0043").await;
    let same = json!({ "badgePhc": badge(&salt, 100_000, 1) });
    let (status, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{first}/badges"),
            Some(same.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    for owner in [&second, &first] {
        let (status, body) = admin
            .call(
                "POST",
                &format!("/v1/office/operators/{owner}/badges"),
                Some(same.clone()),
            )
            .await;
        assert_eq!(
            (status, body["error"]["details"]["constraint"].clone()),
            (StatusCode::CONFLICT, json!("badge"))
        );
    }
    // A revoked badge frees its code; the new badge gets a new id.
    let (status, _) = admin
        .call(
            "DELETE",
            &format!(
                "/v1/office/operators/{first}/badges/{}",
                added["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, again) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{second}/badges"),
            Some(same),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_ne!(again["id"], added["id"]);
}

#[tokio::test]
async fn revoking_a_badge_writes_a_tombstone_and_the_badge_never_comes_back() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let (_, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1) })),
        )
        .await;
    let badge_id = added["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/office/operators/{id}/badges/{badge_id}");

    let (status, body) = admin.call("DELETE", &path, None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let tombstone =
        json!({ "entity": "operator_badges", "id": badge_id, "rev": 4, "deleted": true });
    assert_eq!(feed(&admin, 3).await, json!([tombstone]));
    // From zero: the operator, and the badge only as its tombstone.
    assert_eq!(
        feed(&admin, 1).await,
        json!([
            {
                "entity": "operators", "id": id, "rev": 2, "deleted": false,
                "data": { "login": "0042", "name": "Анна Кузнецова", "role": null, "pinPhc": PIN_4821 }
            },
            tombstone
        ])
    );
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(
        list[0]["badges"][0]["revokedAt"],
        json!(admin.app.state.timestamp())
    );
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.revoke").await,
        vec![admin.row(
            "operator_badge.revoke",
            "operator_badge",
            &badge_id,
            json!({ "operatorId": id })
        )]
    );

    // Revoking it again changes nothing.
    let (status, _) = admin.call("DELETE", &path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.revoke").await.len(),
        1
    );
}

#[tokio::test]
async fn a_badge_is_found_only_under_its_own_operator() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let owner = operator(&admin, "0042").await;
    let other = operator(&admin, "0043").await;
    let (_, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{owner}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1) })),
        )
        .await;
    let badge_id = added["id"].as_str().unwrap();
    for path in [
        format!("/v1/office/operators/{other}/badges/{badge_id}"),
        format!("/v1/office/operators/{owner}/badges/9b2e4a6c-0000-4000-8000-000000000000"),
    ] {
        let (status, body) = admin.call("DELETE", &path, None).await;
        assert_eq!(
            (status, body["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found")),
            "{path}"
        );
    }
    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/operators/9b2e4a6c-0000-4000-8000-000000000000/badges",
            Some(json!({ "badgePhc": badge(&salt, 100_000, 2) })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert!(audit_trail(&admin.app, "operator_badge.revoke")
        .await
        .is_empty());
}

#[tokio::test]
async fn technologists_cannot_touch_badges() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let (_, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1) })),
        )
        .await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 2) })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = admin
        .call_as(
            &tech,
            "DELETE",
            &format!(
                "/v1/office/operators/{id}/badges/{}",
                added["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.create").await.len(),
        1
    );
    assert!(audit_trail(&admin.app, "operator_badge.revoke")
        .await
        .is_empty());
}
```

2. Create `apps/standalone/proto/fixtures/badge-create.json`:

```json
{
  "badgePhc": "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=",
  "label": "Пропуск №7"
}
```

3. Create `apps/standalone/proto/fixtures/badge-salt.json`:

```json
{ "badgeSalt": "AAECAwQFBgcICQoLDA0ODw==" }
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BlockSizesUpdate, BootstrapRequest, BootstrapResponse, ChangesResponse,
    ClaimRequest, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, ErrorBody, Hello, HelloEnvelope,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord,
    OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate,
    OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange,
    PasswordSet, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, ChangesResponse, ClaimRequest, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, ErrorBody, Hello, HelloEnvelope, LineCreate, LineRecord, LineUpdate,
    LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeRole, OfficeSession,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PasswordChange, PasswordSet, SiteRecord, SsccCounterUpdate,
    SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn badge_fixtures_round_trip_without_leaking() {
    let create: BadgeCreate = round_trip("badge-create.json");
    let salt: BadgeSalt = round_trip("badge-salt.json");
    // The badge is hashed with the salt the office read.
    assert_eq!(
        create.badge_phc.expose().split('$').nth(3),
        Some(salt.badge_salt.expose())
    );
    let debug = format!("{create:?} {salt:?}");
    assert!(!debug.contains("pbkdf2"), "{debug}");
    assert!(!debug.contains(salt.badge_salt.expose()), "{debug}");
    // The badge code itself is never a field.
    let mut value = fixture("badge-create.json");
    value["code"] = Value::String("MRK-000742".into());
    assert!(serde_json::from_value::<BadgeCreate>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
```

6. В `apps/standalone/host/src/validate.rs`, в модуле `tests`, фрагмент

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_pin_hash_is_a_domain_phc_string_within_the_iteration_bounds() {
```

заменить на

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_badge_hash_carries_the_site_salt_and_exactly_the_domain_iterations() {
        let salt: Vec<u8> = (0..16).collect();
        let phc = |iterations: u32, salt: &str| {
            format!(
                "pbkdf2$sha256${iterations}${salt}$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0="
            )
        };
        assert!(badge_phc("badgePhc", &phc(100_000, "AAECAwQFBgcICQoLDA0ODw=="), &salt).is_ok());
        for bad in [
            phc(200_000, "AAECAwQFBgcICQoLDA0ODw=="),
            phc(10_000, "AAECAwQFBgcICQoLDA0ODw=="),
            phc(100_000, "bWFya2lyby1waW4tc2FsdA=="),
            "MRK-000742".to_owned(),
        ] {
            assert_eq!(
                field(badge_phc("badgePhc", &bad, &salt)),
                "badgePhc",
                "{bad}"
            );
        }
    }

    #[test]
    fn a_badge_label_is_optional_text_of_at_most_100_characters() {
        assert_eq!(badge_label("label", Some(" ")).unwrap(), None);
        assert!(badge_label("label", Some(&"п".repeat(100))).is_ok());
        assert_eq!(field(badge_label("label", Some(&"п".repeat(101)))), "label");
    }

    #[test]
    fn a_pin_hash_is_a_domain_phc_string_within_the_iteration_bounds() {
```

7. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password hashes, pairing codes, the badge salt or the TLS
//! private key. Its own binary, because it installs the global tracing
//! subscriber.
```

заменить на

<!-- prettier-ignore -->
```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. Its own binary, because it installs the global
//! tracing subscriber.
```

8. Там же фрагмент

<!-- prettier-ignore -->
```rust
use serde_json::json;
```

заменить на

<!-- prettier-ignore -->
```rust
use serde_json::json;

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_PHC: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(refused_claim.status(), 400);
    let refused_claim: serde_json::Value = refused_claim.json().await.unwrap();
    assert_eq!(refused_claim["error"]["code"], "pairing_code_invalid");
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(refused_claim.status(), 400);
    let refused_claim: serde_json::Value = refused_claim.json().await.unwrap();
    assert_eq!(refused_claim["error"]["code"], "pairing_code_invalid");

    // An operator with a PIN, a badge added and revoked, and the feed that
    // carries both hashes to stations: no hash may reach the log, and
    // neither may the badge salt the office reads.
    let operator: serde_json::Value = client
        .post(format!("{base}/v1/office/operators"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "login": "0042", "name": "Анна", "pinPhc": PIN_PHC }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let operator_id = operator["id"].as_str().unwrap().to_owned();
    let badge_salt: serde_json::Value = client
        .get(format!("{base}/v1/office/badge-salt"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let badge_phc = format!(
        "pbkdf2$sha256$100000${}${}",
        badge_salt["badgeSalt"].as_str().unwrap(),
        STANDARD.encode([7u8; 32])
    );
    let badge: serde_json::Value = client
        .post(format!("{base}/v1/office/operators/{operator_id}/badges"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "badgePhc": badge_phc }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let feed = client
        .get(format!("{base}/v1/changes?since=0"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(feed.status(), 200);
    let revoked = client
        .delete(format!(
            "{base}/v1/office/operators/{operator_id}/badges/{}",
            badge["id"].as_str().unwrap()
        ))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 204);
```

10. Там же фрагмент

<!-- prettier-ignore -->
```rust
        pairing_payload,
        claimed_key,
```

заменить на

<!-- prettier-ignore -->
```rust
        pairing_payload,
        claimed_key,
        PIN_PHC.to_owned(),
        "3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=".to_owned(),
        badge_phc,
        STANDARD.encode([7u8; 32]),
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline`
Expected: FAIL — 7 тестов из 7: маршрутов ещё нет, и `site_salt` падает на `GET /v1/office/badge-salt` (`left: 404`, `right: 200`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: FAIL — не компилируется: ``error[E0425]: cannot find function `badge_phc` in this scope`` и то же для `badge_label`.

Run (вне песочницы: тест слушает 127.0.0.1): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline`
Expected: FAIL — ``called `Option::unwrap()` on a `None` value`` на `badge_salt["badgeSalt"]`: маршрута соли ещё нет.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::BadgeCreate`, `markiro_proto::BadgeSalt` ``.

- [ ] **Step 3: Проверка хеша бейджа, записи протокола и маршруты**

1. В `apps/standalone/host/src/secrets.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub const MAX_ITERATIONS: u32 = 1_000_000;
```

заменить на

<!-- prettier-ignore -->
```rust
pub const MAX_ITERATIONS: u32 = 1_000_000;
/// Iterations of a badge verifier: exactly the domain's `PHC_ITERATIONS`, as
/// the cloud hashes badges (`hashBadgeWithSalt` in apps/api), so one badge
/// code under the site's salt always gives one PHC string.
pub const BADGE_ITERATIONS: u32 = 100_000;
```

2. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// A parsed `pbkdf2$sha256$<iterations>$<salt>$<digest>` string.
pub struct Phc {
    pub iterations: u32,
    salt: Vec<u8>,
    digest: Vec<u8>,
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// A parsed `pbkdf2$sha256$<iterations>$<salt>$<digest>` string.
pub struct Phc {
    pub iterations: u32,
    salt: Vec<u8>,
    digest: Vec<u8>,
}

impl Phc {
    /// The decoded salt: 16 bytes.
    pub fn salt(&self) -> &[u8] {
        &self.salt
    }
}
```

3. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// A PIN verifier the office computed: a PHC string in the `@markiro/domain`
```

заменить на

<!-- prettier-ignore -->
```rust
/// A badge's label: free text of at most 100 characters, or none.
pub fn badge_label(field: &str, label: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, label, 100)
}

/// A badge verifier the office computed: a PHC string in the
/// `@markiro/domain` format with exactly `secrets::BADGE_ITERATIONS` and the
/// site's badge salt, as the cloud hashes badges. One badge code then always
/// gives one string, so the partial unique index keeps it on one operator;
/// another count or salt would let a copy of the badge through.
pub fn badge_phc(field: &str, phc: &str, site_salt: &[u8]) -> Result<(), ApiError> {
    match crate::secrets::parse_phc(phc) {
        Some(parsed)
            if parsed.iterations == crate::secrets::BADGE_ITERATIONS
                && parsed.salt() == site_salt =>
        {
            Ok(())
        }
        _ => Err(ApiError::validation(
            field,
            "a PBKDF2 PHC string with 100000 iterations and the site's badge salt is required",
        )),
    }
}

/// A PIN verifier the office computed: a PHC string in the `@markiro/domain`
```

4. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_UPDATE: &str = "operator.update";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
}
```

5. В `apps/standalone/proto/src/lib.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_phc: Option<Secret>,
    pub expected_rev: i64,
}
```

заменить на

<!-- prettier-ignore -->
```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_phc: Option<Secret>,
    pub expected_rev: i64,
}

/// `POST /v1/office/operators/{id}/badges`: the office hashed the badge code
/// with the site's badge salt (`GET /v1/office/badge-salt`) and the domain's
/// 100 000 iterations; the host never sees the code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BadgeCreate {
    pub badge_phc: Secret,
    #[serde(default)]
    pub label: Option<String>,
}

/// `GET /v1/office/badge-salt`: the site's badge salt, 16 bytes in standard
/// base64 with padding — the value the feed's `site` record carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSalt {
    pub badge_salt: Secret,
}
```

6. В `apps/standalone/host/src/routes/operators.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Operators (spec §4.3), administrators only: `GET /v1/office/operators`,
//! `POST` and `PUT …/{id}` (`PUT` with `expectedRev`). The office computes
//! the PIN's PHC string with `@markiro/domain`; the host checks its format
//! and never returns a hash (`hasPin` instead). An operator is in the station
//! feed only while active: a deactivation writes a tombstone and a
//! reactivation drops it (`feed`).

use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::{entities, BadgeInfo, OfficeOperator, OperatorCreate, OperatorUpdate};
```

заменить на

<!-- prettier-ignore -->
```rust
//! Operators (spec §4.3), administrators only: `GET /v1/office/operators`,
//! `POST` and `PUT …/{id}` (`PUT` with `expectedRev`), their badges (`POST
//! …/{id}/badges`, `DELETE …/{id}/badges/{badge_id}`) and the site's badge
//! salt (`GET /v1/office/badge-salt`). The office computes PIN and badge PHC
//! strings with `@markiro/domain`; the host checks their format and never
//! returns a hash (`hasPin` and badge metadata instead). An operator is in
//! the station feed only while active and a badge only while not revoked:
//! leaving it writes a tombstone (`feed`).

use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::{
    entities, BadgeCreate, BadgeInfo, BadgeSalt, OfficeOperator, OperatorCreate, OperatorUpdate,
    Secret,
};
```

7. Там же, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
    let updated = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("operator vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

заменить на

<!-- prettier-ignore -->
```rust
    let updated = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("operator vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// The site's badge salt; `not_found` before the wizard created it.
async fn site_salt(conn: &mut SqliteConnection) -> Result<Vec<u8>, ApiError> {
    let salt: Option<Vec<u8>> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)?;
    salt.ok_or_else(|| ApiError::not_found("the host is not initialized"))
}

/// A write that hit `operator_badges_active_phc`: the badge is already an
/// active badge of some operator.
fn badge_taken(error: sqlx::Error) -> ApiError {
    match error.as_database_error() {
        Some(database) if database.is_unique_violation() => {
            ApiError::conflict("badge", "this badge already belongs to an operator")
        }
        _ => ApiError::internal(error),
    }
}

/// `GET /v1/office/badge-salt` (administrators): the salt the office hashes
/// badge codes with, as stations and the cloud do.
pub async fn badge_salt(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<BadgeSalt>, ApiError> {
    context.require_admin()?;
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let salt = site_salt(&mut conn).await?;
    Ok(Json(BadgeSalt {
        badge_salt: Secret::new(STANDARD.encode(salt)),
    }))
}

/// `POST /v1/office/operators/{id}/badges` (administrators): a badge hashed
/// with the site's salt. A badge code belongs to one operator at a time.
pub async fn create_badge(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(operator_id): ApiPath<String>,
    ApiJson(create): ApiJson<BadgeCreate>,
) -> Result<Json<BadgeInfo>, ApiError> {
    context.require_admin()?;
    let label = validate::badge_label("label", create.label.as_deref())?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let salt = site_salt(&mut tx).await?;
    validate::badge_phc("badgePhc", create.badge_phc.expose(), &salt)?;
    let operator: Option<i64> = sqlx::query_scalar("SELECT 1 FROM operators WHERE id = ?")
        .bind(&operator_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if operator.is_none() {
        return Err(ApiError::not_found("no such operator"));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&operator_id)
    .bind(create.badge_phc.expose())
    .bind(&label)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(badge_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_BADGE_CREATE,
            target_type: Some("operator_badge"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "operatorId": operator_id, "label": label }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(BadgeInfo {
        id,
        label,
        created_at: at,
        revoked_at: None,
    }))
}

/// `DELETE /v1/office/operators/{id}/badges/{badge_id}` (administrators):
/// revoke the badge. It leaves the station feed as a tombstone and never
/// comes back; revoking a revoked badge changes nothing.
pub async fn revoke_badge(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath((operator_id, badge_id)): ApiPath<(String, String)>,
) -> Result<StatusCode, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let revoked_at: Option<Option<String>> = sqlx::query_scalar(
        "SELECT revoked_at FROM operator_badges WHERE id = ? AND operator_id = ?",
    )
    .bind(&badge_id)
    .bind(&operator_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    match revoked_at {
        None => return Err(ApiError::not_found("no such badge of this operator")),
        // Already revoked: no revision, no row write, no audit row.
        Some(Some(_)) => return Ok(StatusCode::NO_CONTENT),
        Some(None) => {}
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE operator_badges SET revoked_at = ?, rev = ? WHERE id = ?")
        .bind(&at)
        .bind(rev)
        .bind(&badge_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    feed::remove(&mut tx, entities::OPERATOR_BADGES, &badge_id, rev)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_BADGE_REVOKE,
            target_type: Some("operator_badge"),
            target_id: Some(&badge_id),
            outcome: Outcome::Ok,
            details: json!({ "operatorId": operator_id }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
```

8. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
use axum::routing::{get, post, put};
```

заменить на

<!-- prettier-ignore -->
```rust
use axum::routing::{delete, get, post, put};
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/operators/{id}",
            put(crate::routes::operators::update_operator),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/operators/{id}",
            put(crate::routes::operators::update_operator),
        )
        .route(
            "/v1/office/operators/{id}/badges",
            post(crate::routes::operators::create_badge),
        )
        .route(
            "/v1/office/operators/{id}/badges/{badge_id}",
            delete(crate::routes::operators::revoke_badge),
        )
        .route(
            "/v1/office/badge-salt",
            get(crate::routes::operators::badge_salt),
        )
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline`
Expected: PASS — 7 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
Expected: PASS — 25 тестов (23 и два новых `validate::tests`).

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline`
Expected: PASS — 1 тест.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 25 тестов.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
## Reference sync

`src/local/reference-sync.ts` keeps the local copies in step with the host
```

заменить на

<!-- prettier-ignore -->
```text
## Operators and badges

Operators sign in on stations with a personnel number and a PIN, or with a
badge (plan 1f). The office hashes both with `@markiro/domain`, so the host
never sees a PIN or a badge code: it stores PHC strings and checks their
format with `secrets::parse_phc` — canonical base64, a 16-byte salt, a
32-byte digest and 10 000–1 000 000 iterations, since a station verifies
with the count the hash carries. A badge hash must also carry exactly the
domain's 100 000 iterations and the site's badge salt
(`GET /v1/office/badge-salt`, the same value as the `site` record's
`badgeSalt`), as the cloud hashes badges: one badge code then always gives
one string, and the partial unique index `operator_badges_active_phc` keeps
it on one operator (`conflict` with `constraint: badge`). The office never
gets a hash back: operator reads carry `hasPin` and each badge's `id`,
`label`, `createdAt` and `revokedAt`. Revoking a badge is
`DELETE …/badges/{badgeId}`, and revoking it again changes nothing.
Operators, badges and the salt are for administrators only, reads included.

## Reference sync

`src/local/reference-sync.ts` keeps the local copies in step with the host
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.3, фрагмент

<!-- prettier-ignore -->
```text
  не может принадлежать двум операторам (соль общая, значит одинаковый код даёт
  одинаковый хеш).
```

заменить на

<!-- prettier-ignore -->
```text
  не может принадлежать двум операторам (соль общая, значит одинаковый код даёт
  одинаковый хеш). Поэтому хеш бейджа обязан нести соль площадки
  (`GET /v1/office/badge-salt`) и ровно 100 000 итераций, как `hashBadgeWithSalt`
  облака: с другим числом итераций копия бейджа прошла бы мимо индекса. Повтор —
  `conflict` с `constraint: badge`. Подпись (`label`) — до 100 символов или пусто.
  Отзыв — `DELETE …/badges/{badgeId}`: `revoked_at` и надгробие; повторный отзыв
  ничего не меняет.
```

3. Там же, §4.5, фрагмент

<!-- prettier-ignore -->
```text
  `operator-create.json`, `operator-update.json` (`PUT` меняет только присланные
  поля; `role: null` очищает должность, её отсутствие — оставляет).
```

заменить на

<!-- prettier-ignore -->
```text
  `operator-create.json`, `operator-update.json` (`PUT` меняет только присланные
  поля; `role: null` очищает должность, её отсутствие — оставляет);
- бейджи — `badge-create.json` (`badgePhc` с солью площадки и `label`; ответ —
  сведения о бейдже, как в `office-operator.json`), `badge-salt.json` (ответ
  `GET /v1/office/badge-salt`).
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/badge-create.json apps/standalone/proto/fixtures/badge-salt.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

```bash
git add apps/standalone/host/src/secrets.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/routes/operators.rs apps/standalone/host/tests/badges.rs apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/badge-create.json apps/standalone/proto/fixtures/badge-salt.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): бейджи операторов и соль бейджей на хосте" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Устройства — `PUT /v1/office/devices/{id}` и отзыв с концом потоков и сессий

Администратор меняет имя устройства и его линию (`lineId: null` снимает линию) и отзывает устройство. У устройств нет `rev`, и они не в ленте, поэтому запись побеждает последней, а ревизия хоста не меняется — как у выбора линии станцией (`PUT /v1/device/line`, план 1c1). Линию можно назначить только станции и только неархивную; проверка активной линии становится общей для офиса и станции (`require_active_line`).

Отзыв (`POST /v1/office/devices/{id}/revoke`):

- ставит `revoked_at`, и ключ сразу перестаёт работать: `AuthDevice` уже ищет только неотозванные ключи, поэтому каждый следующий запрос с ним получает `unauthorized` с `credential: device`;
- удаляет офисные сессии этого устройства в той же транзакции;
- после коммита будит открытые потоки изменений через `AppState::revocations` (`watch` со счётчиком отзывов). Поток, разбуженный отзывом, перечитывает своё устройство и заканчивается, если его отозвали. Счётчик, а не список устройств: канал не переполняется, а решает база. Отложено с плана 1c1: раньше `AuthDevice` проверял ключ только при открытии потока;
- при открытии поток подписывается на отзывы и только потом ещё раз проверяет устройство: отзыв между проверкой ключа в `AuthDevice` и подпиской не потеряется;
- отвечает записью устройства с `revokedAt`; отозванное устройство остаётся в `GET /v1/office/devices` (отложено с плана 1c1). Повторный отзыв ничего не меняет — ни записи, ни строки журнала: запрос, повторённый после потерянного ответа, не должен падать.

Администратор может отозвать и то устройство, с которого работает: его сессия закончится вместе с остальными, а следующий запрос получит `unauthorized` с `credential: device`. На ПК хоста такое устройство подключается снова через loopback. Предупредить об этом в интерфейсе — задача экрана «Устройства» (план 1d3).

**Files:**

- Create: `apps/standalone/host/tests/devices.rs`, `apps/standalone/proto/fixtures/device-update.json`
- Modify (целиком): `apps/standalone/host/src/routes/devices.rs`
- Modify: `apps/standalone/host/src/{validate,audit,server}.rs`, `apps/standalone/host/src/routes/changes.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/changes_stream.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Change feed», «Device key and office session»), спецификация §4.5, §4.7

**Interfaces:**

- Consumes:
  - `AuthDevice` (ищет `revoked_at IS NULL`), `OfficeContext` — `host/src/auth.rs`;
  - `db::current_revision`, `AppState::{revisions, stopping, pool}`;
  - `nullable` — `proto/src/lib.rs` (задача 4);
  - `Admin`, `admin`, `audit_trail`, `host_revision`, `pair_device`, `seed_office_user`, `login` — `host/tests/support/app.rs`.
- Produces:
  - `pub revocations: Arc<watch::Sender<u64>>` в `AppState`;
  - `pub fn validate::device_name<'a>(field: &str, name: &'a str) -> Result<&'a str, ApiError>`;
  - `actions::DEVICE_UPDATE = "device.update"`, `actions::DEVICE_REVOKE = "device.revoke"`;
  - `DeviceUpdate { name: Option<String>, line_id: Option<Option<String>> }` — `proto/src/lib.rs`;
  - маршруты `PUT /v1/office/devices/{id}` → `DeviceRecord`, `POST /v1/office/devices/{id}/revoke` → `DeviceRecord`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/host/tests/devices.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, empty, host_revision, login, pair_device, request, seed_office_user,
    with_device, with_session, Admin,
};

async fn line_ids(admin: &Admin) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM lines ORDER BY name")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The office's record of one device.
async fn device(admin: &Admin, id: &str) -> Value {
    let (status, list) = admin.call("GET", "/v1/office/devices", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list.as_array()
        .unwrap()
        .iter()
        .find(|device| device["id"] == id)
        .unwrap()
        .clone()
}

#[tokio::test]
async fn an_administrator_renames_a_device_and_sets_its_line() {
    let admin = admin().await;
    let (station, station_key) = pair_device(&admin.app, "station").await;
    let lines = line_ids(&admin).await;
    let path = format!("/v1/office/devices/{station}");
    let revision = host_revision(&admin.app).await;

    let (status, renamed) = admin
        .call("PUT", &path, Some(json!({ "name": " Станция упаковки " })))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        (renamed["name"].clone(), renamed["lineId"].clone()),
        (json!("Станция упаковки"), Value::Null)
    );
    let (status, assigned) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[0] })))
        .await;
    assert_eq!(
        (status, assigned["lineId"].clone()),
        (StatusCode::OK, json!(lines[0]))
    );
    // The station sees its line.
    let (_, info) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device"),
            &station_key,
        )))
        .await;
    assert_eq!(info["lineId"], json!(lines[0]));
    let (status, cleared) = admin
        .call("PUT", &path, Some(json!({ "lineId": null })))
        .await;
    assert_eq!(
        (status, cleared["lineId"].clone(), cleared["name"].clone()),
        (StatusCode::OK, Value::Null, json!("Станция упаковки"))
    );
    assert_eq!(cleared, device(&admin, &station).await);
    assert_eq!(
        host_revision(&admin.app).await,
        revision,
        "devices are not in the change feed"
    );
    assert_eq!(
        audit_trail(&admin.app, "device.update").await,
        vec![
            admin.row(
                "device.update",
                "device",
                &station,
                json!({ "changed": ["name"], "name": { "from": "Тестовое устройство", "to": "Станция упаковки" } })
            ),
            admin.row(
                "device.update",
                "device",
                &station,
                json!({ "changed": ["lineId"], "lineId": { "from": null, "to": lines[0] } })
            ),
            admin.row(
                "device.update",
                "device",
                &station,
                json!({ "changed": ["lineId"], "lineId": { "from": lines[0], "to": null } })
            ),
        ]
    );
    // Nothing to change: no row.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Станция упаковки", "lineId": null })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, cleared));
    assert_eq!(audit_trail(&admin.app, "device.update").await.len(), 3);
}

#[tokio::test]
async fn a_device_line_is_an_active_line_and_only_a_stations() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let (office, _) = pair_device(&admin.app, "office").await;
    let lines = line_ids(&admin).await;
    sqlx::query("UPDATE lines SET archived = 1 WHERE id = ?")
        .bind(&lines[1])
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    for (device, line) in [
        (&station, lines[1].as_str()),
        (&station, "9b2e4a6c-0000-4000-8000-000000000000"),
        (&office, lines[0].as_str()),
    ] {
        let (status, body) = admin
            .call(
                "PUT",
                &format!("/v1/office/devices/{device}"),
                Some(json!({ "lineId": line })),
            )
            .await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("lineId")),
            "{device} {line}"
        );
    }
    // Clearing is always allowed; an office device has no line to clear.
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{office}"),
            Some(json!({ "lineId": null })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{station}"),
            Some(json!({ "name": " " })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{station}"),
            Some(json!({ "kind": "office" })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(audit_trail(&admin.app, "device.update").await.is_empty());
}

#[tokio::test]
async fn revoking_a_device_refuses_its_key_and_ends_its_office_sessions() {
    let admin = admin().await;
    let (office, office_key) = pair_device(&admin.app, "office").await;
    seed_office_user(&admin.app, "tech", "technologist", "technologist password").await;
    let tech_on_office = login(&admin.app, &office_key, "tech", "technologist password").await;
    let tech_on_station = login(&admin.app, &admin.key, "tech", "technologist password").await;

    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{office}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert_eq!(revoked["revokedAt"], json!(admin.app.state.timestamp()));
    // A revoked device stays listed.
    assert_eq!(device(&admin, &office).await, revoked);
    // Its key is refused at once, the office session on it included...
    for path in ["/v1/device", "/v1/changes", "/v1/changes/stream"] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", path), &office_key)))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{path}"
        );
    }
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &office_key,
            &tech_on_office,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // ...its sessions are gone, and a session on another device stays.
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE device_id = ?")
            .bind(&office)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0);
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &tech_on_station,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        audit_trail(&admin.app, "device.revoke").await,
        vec![admin.row(
            "device.revoke",
            "device",
            &office,
            json!({ "kind": "office", "name": "Тестовое устройство" })
        )]
    );

    // Revoking it again changes nothing.
    let (status, again) = admin
        .call("POST", &format!("/v1/office/devices/{office}/revoke"), None)
        .await;
    assert_eq!((status, again), (StatusCode::OK, revoked));
    assert_eq!(audit_trail(&admin.app, "device.revoke").await.len(), 1);
}

#[tokio::test]
async fn an_administrator_may_revoke_the_device_they_use() {
    let admin = admin().await;
    let own: String = sqlx::query_scalar("SELECT device_id FROM office_sessions WHERE user_id = ?")
        .bind(&admin.id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{own}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let (status, body) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
}

#[tokio::test]
async fn technologists_cannot_manage_devices() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &format!("/v1/office/devices/{station}"),
            Some(json!({ "name": "Станция" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            &format!("/v1/office/devices/{station}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(device(&admin, &station).await["revokedAt"], Value::Null);
    assert!(audit_trail(&admin.app, "device.update").await.is_empty());
    assert!(audit_trail(&admin.app, "device.revoke").await.is_empty());
}

#[tokio::test]
async fn an_unknown_device_is_not_found_once_the_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/devices/9b2e4a6c-0000-4000-8000-000000000000";
    let (status, body) = admin.call("PUT", path, Some(json!({ "name": " " }))).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": "Станция" })))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    let (status, body) = admin.call("POST", &format!("{path}/revoke"), None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}
```

2. В `apps/standalone/host/tests/changes_stream.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
    assert!(
        matches!(stream.chunk().await, Ok(None)),
        "the stream ended cleanly with the host"
    );
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(
        matches!(stream.chunk().await, Ok(None)),
        "the stream ended cleanly with the host"
    );
}

/// A revocation ends the revoked device's open stream at once, not at its
/// next heartbeat (15 s here), and leaves other devices' streams open.
#[tokio::test]
async fn revoking_a_device_ends_its_open_stream_and_no_other() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (other, other_key) = pair_device(&app, "station").await;

    let (status, _, mut revoked) = open_stream(&app, &other_key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut revoked).await, rev_event(1));
    let (_, _, mut kept) = open_stream(&app, &key).await;
    assert_eq!(next_text(&mut kept).await, rev_event(1));

    let (status, body) = app
        .send(empty(with_session(
            request("POST", &format!("/v1/office/devices/{other}/revoke")),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let frame = tokio::time::timeout(Duration::from_secs(5), revoked.frame())
        .await
        .expect("the revoked device's stream ends within 5 s");
    assert!(frame.is_none(), "the stream ended cleanly");

    // The other stream is still open and gets the next revision.
    let (status, org) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &token),
            org_update(1),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{org}");
    assert_eq!(
        next_text(&mut kept).await,
        rev_event(org["rev"].as_i64().unwrap())
    );
}
```

3. Create `apps/standalone/proto/fixtures/device-update.json`:

```json
{ "name": "Станция упаковки", "lineId": null }
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, ChangesResponse, ClaimRequest, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, ErrorBody, Hello, HelloEnvelope, LineCreate, LineRecord, LineUpdate,
    LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeRole, OfficeSession,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PasswordChange, PasswordSet, SiteRecord, SsccCounterUpdate,
    SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, ChangesResponse, ClaimRequest, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LineCreate, LineRecord,
    LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange, PasswordSet,
    SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn a_device_update_tells_a_cleared_line_from_an_absent_one() {
    let update: DeviceUpdate = round_trip("device-update.json");
    assert_eq!(update.line_id, Some(None));
    let rename: DeviceUpdate =
        serde_json::from_value(serde_json::json!({ "name": "Станция" })).unwrap();
    assert_eq!(rename.line_id, None);
    let line = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    let assign: DeviceUpdate =
        serde_json::from_value(serde_json::json!({ "lineId": line })).unwrap();
    assert_eq!(assign.line_id, Some(Some(line.to_owned())));
    let mut value = fixture("device-update.json");
    value["kind"] = Value::String("office".into());
    assert!(serde_json::from_value::<DeviceUpdate>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
```

6. В `apps/standalone/host/src/validate.rs`, в модуле `tests`, фрагмент

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_badge_label_is_optional_text_of_at_most_100_characters() {
```

заменить на

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_device_name_is_trimmed_to_1_to_100_characters() {
        assert_eq!(device_name("name", " Станция 2 ").unwrap(), "Станция 2");
        assert!(device_name("name", &"с".repeat(100)).is_ok());
        assert_eq!(field(device_name("name", " ")), "name");
        assert_eq!(field(device_name("name", &"с".repeat(101))), "name");
        assert_eq!(field(device_registration(" ", "0.1.0", &[])), "name");
    }

    #[test]
    fn a_badge_label_is_optional_text_of_at_most_100_characters() {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test devices --offline`
Expected: FAIL — 6 тестов из 6: маршрутов ещё нет, и хост отвечает `404` там, где тесты ждут `200` или `400`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream revoking --offline`
Expected: FAIL — `revoking_a_device_ends_its_open_stream_and_no_other`: `left: 404`, `right: 200` на отзыве (7 тестов отфильтрованы).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: FAIL — не компилируется: ``error[E0425]: cannot find function `device_name` in this scope``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_proto::DeviceUpdate` ``.

- [ ] **Step 3: Отзывы в `AppState`, маршруты устройств и конец потока**

1. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub fn device_registration<'a>(
    name: &'a str,
    app_version: &'a str,
    capabilities: &[String],
) -> Result<(&'a str, &'a str), ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::validation(
            "name",
            "the name must be 1-100 characters",
        ));
    }
```

заменить на

<!-- prettier-ignore -->
```rust
pub fn device_registration<'a>(
    name: &'a str,
    app_version: &'a str,
    capabilities: &[String],
) -> Result<(&'a str, &'a str), ApiError> {
    let name = device_name("name", name)?;
```

2. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// A production line name: trimmed, 1-100 characters. Returns the name and
```

заменить на

<!-- prettier-ignore -->
```rust
/// A device's name: trimmed, 1-100 characters.
pub fn device_name<'a>(field: &str, name: &'a str) -> Result<&'a str, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        Err(ApiError::validation(
            field,
            "the name must be 1-100 characters",
        ))
    } else {
        Ok(name)
    }
}

/// A production line name: trimmed, 1-100 characters. Returns the name and
```

3. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
}
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// `PUT /v1/office/devices/{id}`: only the fields sent change; `lineId: null`
/// clears the line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub line_id: Option<Option<String>>,
}
```

5. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// Becomes `true` once when the host stops; open change streams end.
    pub stopping: Arc<watch::Sender<bool>>,
```

заменить на

<!-- prettier-ignore -->
```rust
    /// Becomes `true` once when the host stops; open change streams end.
    pub stopping: Arc<watch::Sender<bool>>,
    /// Counts device revocations; raised after each revoking commit. A change
    /// stream woken by it checks its own device and ends if that was revoked.
    pub revocations: Arc<watch::Sender<u64>>,
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
            stopping: Arc::new(watch::channel(false).0),
            stream_heartbeat: Duration::from_secs(15),
```

заменить на

<!-- prettier-ignore -->
```rust
            stopping: Arc::new(watch::channel(false).0),
            revocations: Arc::new(watch::channel(0).0),
            stream_heartbeat: Duration::from_secs(15),
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/devices",
            get(crate::routes::devices::list_devices),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/devices",
            get(crate::routes::devices::list_devices),
        )
        .route(
            "/v1/office/devices/{id}",
            put(crate::routes::devices::update_device),
        )
        .route(
            "/v1/office/devices/{id}/revoke",
            post(crate::routes::devices::revoke_device),
        )
```

8. Заменить содержимое `apps/standalone/host/src/routes/devices.rs` целиком:

```rust
//! A device's own record (`GET /v1/device`), a station's choice of line
//! (`PUT /v1/device/line`) and the administrator's devices:
//! `GET /v1/office/devices`, `PUT /v1/office/devices/{id}` (name and line)
//! and `POST /v1/office/devices/{id}/revoke`. Devices are not in the change
//! feed and have no `rev`: office writes are last-write-wins and leave the
//! host revision alone.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{AuthDevice, OfficeContext};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

async fn read_info(
    conn: &mut SqliteConnection,
    device: &AuthDevice,
) -> Result<DeviceInfo, ApiError> {
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

/// `line_id` names an existing, active line.
async fn require_active_line(conn: &mut SqliteConnection, line_id: &str) -> Result<(), ApiError> {
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM lines WHERE id = ?")
        .bind(line_id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    if archived == Some(0) {
        Ok(())
    } else {
        Err(ApiError::validation("lineId", "no such active line"))
    }
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
    require_active_line(&mut tx, &request.line_id).await?;
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
    let kind: DeviceKind =
        serde_json::from_value(serde_json::Value::String(row.kind)).map_err(ApiError::internal)?;
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
}

async fn read_record(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<DeviceRecord>, ApiError> {
    let row: Option<DeviceRow> = sqlx::query_as(&format!("{DEVICES} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// `GET /v1/office/devices` (administrators): every paired device, revoked
/// ones included, in pairing order.
pub async fn list_devices(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<DeviceRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<DeviceRow> = sqlx::query_as(&format!("{DEVICES} ORDER BY paired_at, id"))
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

/// `PUT /v1/office/devices/{id}` (administrators): rename a device or set
/// its line — only a station's, only an active line; `lineId: null` clears
/// it.
pub async fn update_device(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<DeviceUpdate>,
) -> Result<Json<DeviceRecord>, ApiError> {
    context.require_admin()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::device_name("name", name))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such device"))?;
    let line_id = match &update.line_id {
        None => current.line_id.clone(),
        Some(None) => None,
        Some(Some(line_id)) => {
            if current.kind != DeviceKind::Station {
                return Err(ApiError::validation(
                    "lineId",
                    "only a station works on a line",
                ));
            }
            require_active_line(&mut tx, line_id).await?;
            Some(line_id.clone())
        }
    };
    let name = name.map_or_else(|| current.name.clone(), str::to_owned);
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("lineId", json!(current.line_id), json!(line_id)),
    ]) else {
        // Nothing actually changed: report the device as-is without writing a
        // row nobody changed or auditing a no-op.
        return Ok(Json(current));
    };
    sqlx::query("UPDATE devices SET name = ?, line_id = ? WHERE id = ?")
        .bind(&name)
        .bind(&line_id)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DEVICE_UPDATE,
            target_type: Some("device"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("device vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// `POST /v1/office/devices/{id}/revoke` (administrators): the device's key
/// stops working at once, its office sessions end and, after the commit, its
/// open change streams close (`AppState::revocations`). The device stays
/// listed with `revokedAt`; revoking it again changes nothing.
pub async fn revoke_device(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<DeviceRecord>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such device"))?;
    if current.revoked_at.is_some() {
        // Already revoked: no row write, no audit row.
        return Ok(Json(current));
    }
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(&at)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM office_sessions WHERE device_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DEVICE_REVOKE,
            target_type: Some("device"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "kind": current.kind.as_str(), "name": current.name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let revoked = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("device vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    // After the commit, like a revision: a stream that checks its device at
    // once already reads the revocation.
    state
        .revocations
        .send_modify(|count| *count = count.wrapping_add(1));
    Ok(Json(revoked))
}
```

9. В `apps/standalone/host/src/routes/changes.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! with server-sent events so a device does not have to poll for the next
//! one. Adding an entity means a branch in `FEED_KEYS` and in `record`, its
```

заменить на

<!-- prettier-ignore -->
```rust
//! with server-sent events so a device does not have to poll for the next
//! one, until the host stops or the device is revoked. Adding an entity
//! means a branch in `FEED_KEYS` and in `record`, its
```

10. Там же фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    entities, ChangeItem, ChangesResponse, LineRecord, OperatorBadgeRecord, OperatorRecord,
    OrgRecord, Secret, SiteRecord,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    credentials, entities, ChangeItem, ChangesResponse, LineRecord, OperatorBadgeRecord,
    OperatorRecord, OrgRecord, Secret, SiteRecord,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use tokio::sync::watch;
```

11. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// `GET /v1/changes/stream`: server-sent events. The first `rev` event
/// carries the current revision; after that, an event whenever the revision
/// grew. Events are strictly increasing, so a burst of commits collapses
/// into one, and an event means "fetch since your revision", not "a commit
/// happened". A comment line every heartbeat keeps the connection alive; the
/// stream ends when the host stops.
pub async fn stream(
    State(state): State<AppState>,
    _device: AuthDevice,
) -> Result<impl IntoResponse, ApiError> {
    // Subscribe before reading the current revision: a commit in between
    // then shows up as one more event instead of being missed.
    let revisions = state.revisions.subscribe();
    let stopping = state.stopping.subscribe();
    let current = {
        let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
        db::current_revision(&mut conn)
            .await
            .map_err(ApiError::internal)?
    };
    let events = unfold(
        (Some(current), current, revisions, stopping),
        |(first, mut last, mut revisions, mut stopping)| async move {
            if let Some(rev) = first {
                last = rev;
                return Some((
                    Ok::<_, Infallible>(rev_event(rev)),
                    (None, last, revisions, stopping),
                ));
            }
            loop {
                if *stopping.borrow() {
                    return None;
                }
                // An arm body cannot move `stopping` into the next `unfold`
                // state: `wait_for` resolves to a `watch::Ref` that borrows
                // `stopping` and lives in `select!`'s output until the whole
                // expression ends. Resolve only the new revision here, then
                // build the next state in a later statement, once that
                // borrow has ended.
                let rev = tokio::select! {
                    changed = revisions.changed() => {
                        changed.ok()?;
                        Some(*revisions.borrow_and_update())
                    }
                    _ = stopping.wait_for(|stopping| *stopping) => None,
                };
                let rev = rev?;
                // A watch change is not always news: a burst of commits can
                // coalesce into one wakeup, and a value at or below `last`
                // (nothing yet on the host, or a lower value written
                // directly, as in tests) is not forward progress. Keep
                // waiting for a revision the device has not already been
                // told about instead of sending a non-increasing event.
                if rev > last {
                    last = rev;
                    return Some((Ok(rev_event(rev)), (None, last, revisions, stopping)));
                }
            }
        },
    );
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(state.stream_heartbeat)))
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// `GET /v1/changes/stream`: server-sent events. The first `rev` event
/// carries the current revision; after that, an event whenever the revision
/// grew. Events are strictly increasing, so a burst of commits collapses
/// into one, and an event means "fetch since your revision", not "a commit
/// happened". A comment line every heartbeat keeps the connection alive; the
/// stream ends when the host stops or its device is revoked.
pub async fn stream(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<impl IntoResponse, ApiError> {
    // Subscribe before reading the current revision: a commit in between
    // then shows up as one more event instead of being missed. Revocations
    // likewise: one committed after `AuthDevice` read the key but before
    // this subscription is caught by the check below instead.
    let revisions = state.revisions.subscribe();
    let revocations = state.revocations.subscribe();
    let stopping = state.stopping.subscribe();
    let current = {
        let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
        if !device_active(&mut *conn, &device.id)
            .await
            .map_err(ApiError::internal)?
        {
            return Err(ApiError::unauthorized(
                credentials::DEVICE,
                "unknown or revoked device key",
            ));
        }
        db::current_revision(&mut conn)
            .await
            .map_err(ApiError::internal)?
    };
    let follow = Follow {
        first: Some(current),
        last: current,
        revisions,
        revocations,
        stopping,
        pool: state.pool.clone(),
        device_id: device.id,
    };
    let events = unfold(follow, |mut follow| async move {
        if let Some(rev) = follow.first.take() {
            follow.last = rev;
            return Some((Ok::<_, Infallible>(rev_event(rev)), follow));
        }
        loop {
            if *follow.stopping.borrow() {
                return None;
            }
            // `wait_for` resolves to a `watch::Ref` that borrows `stopping`
            // until the whole `select!` ends, so the arms only say what woke
            // the stream; `follow` moves into the next state afterwards.
            let wake = tokio::select! {
                changed = follow.revisions.changed() => match changed {
                    Ok(()) => Wake::Revision(*follow.revisions.borrow_and_update()),
                    Err(_) => Wake::Stop,
                },
                changed = follow.revocations.changed() => match changed {
                    Ok(()) => Wake::Revocation,
                    Err(_) => Wake::Stop,
                },
                _ = follow.stopping.wait_for(|stopping| *stopping) => Wake::Stop,
            };
            match wake {
                Wake::Stop => return None,
                // Some device was revoked: end this stream if it was this
                // one. A failed check ends it too; the device reconnects, and
                // `AuthDevice` checks its key again.
                Wake::Revocation => {
                    if !device_active(&follow.pool, &follow.device_id)
                        .await
                        .unwrap_or(false)
                    {
                        return None;
                    }
                }
                // A watch change is not always news: a burst of commits can
                // coalesce into one wakeup, and a value at or below `last`
                // (nothing yet on the host, or a lower value written
                // directly, as in tests) is not forward progress. Keep
                // waiting for a revision the device has not already been
                // told about instead of sending a non-increasing event.
                Wake::Revision(rev) if rev > follow.last => {
                    follow.last = rev;
                    return Some((Ok(rev_event(rev)), follow));
                }
                Wake::Revision(_) => {}
            }
        }
    });
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(state.stream_heartbeat)))
}

/// What a change stream carries from one event to the next.
struct Follow {
    /// The current revision, sent as the first event.
    first: Option<i64>,
    /// The last revision sent.
    last: i64,
    revisions: watch::Receiver<i64>,
    revocations: watch::Receiver<u64>,
    stopping: watch::Receiver<bool>,
    pool: SqlitePool,
    device_id: String,
}

/// What woke a change stream.
enum Wake {
    Revision(i64),
    Revocation,
    Stop,
}

/// The device is paired and not revoked.
async fn device_active<'c>(
    executor: impl SqliteExecutor<'c>,
    id: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL")
            .bind(id)
            .fetch_optional(executor)
            .await?;
    Ok(found.is_some())
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test devices --test device_line --offline`
Expected: PASS — 6 и 4 теста: выбор линии станцией идёт через общую `require_active_line` как раньше.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream --offline` (вне песочницы: `open_streams_end_when_the_host_stops` слушает 127.0.0.1)
Expected: PASS — 8 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
Expected: PASS — 26 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 26 тестов.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «Change feed», фрагмент

<!-- prettier-ignore -->
```text
alive every 15 s, and streams end when the host stops. A new feed entity
```

заменить на

<!-- prettier-ignore -->
```text
alive every 15 s, and streams end when the host stops or when their device
is revoked: a revocation raises `AppState::revocations` after its commit,
and every open stream re-reads its own device then. A new feed entity
```

2. Там же, в разделе «Device key and office session», фрагмент

<!-- prettier-ignore -->
```text
- The office session token lives only in webview memory. «Выйти в цех» ends
```

заменить на

<!-- prettier-ignore -->
```text
- An administrator revokes a device with `POST /v1/office/devices/{id}/revoke`:
  its key is refused at once (`unauthorized` with `credential: device`), its
  office sessions are deleted in the same transaction and its open change
  streams end. It stays in `GET /v1/office/devices` with `revokedAt`, and
  revoking it again changes nothing. `PUT /v1/office/devices/{id}` renames a
  device or sets its line (`lineId: null` clears it; only a station's, only
  an active line). Devices have no `rev` and are not in the feed, so the last
  office write wins and the host revision stays.
- The office session token lives only in webview memory. «Выйти в цех» ends
```

3. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.5, фрагмент

<!-- prettier-ignore -->
```text
- бейджи — `badge-create.json` (`badgePhc` с солью площадки и `label`; ответ —
  сведения о бейдже, как в `office-operator.json`), `badge-salt.json` (ответ
  `GET /v1/office/badge-salt`).
```

заменить на

<!-- prettier-ignore -->
```text
- бейджи — `badge-create.json` (`badgePhc` с солью площадки и `label`; ответ —
  сведения о бейдже, как в `office-operator.json`), `badge-salt.json` (ответ
  `GET /v1/office/badge-salt`);
- устройства — `device-update.json` (`PUT` меняет только присланные `name` и
  `lineId`; `lineId: null` снимает линию); ответ `PUT` и отзыва —
  `device-record.json`.
```

4. Там же, §4.7, фрагмент

<!-- prettier-ignore -->
```text
- Отзыв устройства в офисе делает его ключ недействительным сразу; сессии офиса этого
  устройства закрываются.
```

заменить на

<!-- prettier-ignore -->
```text
- Отзыв устройства в офисе (`POST /v1/office/devices/{id}/revoke`) делает его ключ
  недействительным сразу (`unauthorized` с `credential: device`); сессии офиса этого
  устройства закрываются, его открытые потоки изменений заканчиваются. Отозванное
  устройство остаётся в списке с `revokedAt`; повторный отзыв ничего не меняет.
  `PUT /v1/office/devices/{id}` меняет имя и линию (`lineId: null` снимает линию;
  линия — только у станции и только неархивная). У устройств нет `rev`: побеждает
  последняя запись, ревизия хоста не меняется.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/device-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

```bash
git add apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/routes/devices.rs apps/standalone/host/src/routes/changes.rs apps/standalone/host/tests/devices.rs apps/standalone/host/tests/changes_stream.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/device-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): устройства в офисе хоста, отзыв закрывает ключ, сессии и потоки" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Коды подключения — `id`, `createdAt` и `replaces`

Решение владельца от 2026-09-27: «Новый код» гасит код, который заменяет. `POST /v1/office/pairing-codes` принимает необязательное тело `{ replaces?: <id кода> }`, а ответ получает `id` и `createdAt` рядом с `code`, `expiresAt` и `payload`.

- Живой код (не использован, не истёк, меньше 5 неудачных попыток), созданный тем же офисным пользователем, истекает в той же транзакции, что выдаёт новый: хост ставит ему `expires_at` = сейчас. Поэтому `claim` с ним отвечает `pairing_code_expired`, а не `pairing_code_invalid`: код был настоящим и перестал действовать, а не набран с ошибкой; устройство покажет «код истёк, возьмите новый с экрана офиса», а не «проверьте код». Заодно погашенный код выпадает из живых кодов, которым засчитывается неверная попытка. Строка журнала отказа — `code_expired`: отличить погашенный код от истёкшего можно по строке `pairing_code.create` нового кода, где стоит `replaces`.
- `replaces`, который называет что-то другое — код другого пользователя, неизвестный, использованный, истёкший или исчерпавший попытки, — хост пропускает и всё равно выдаёт новый код. Отказ ничем бы не защитил, но сломал бы «Новый код» в самом частом случае: прежний код уже умер сам, от времени или от неверных попыток. Коды других пользователей не трогаются никогда.
- Замену записывает строка `pairing_code.create` нового кода: `{ expiresAt, replaces: <id> }`, и `replaces` в ней только тогда, когда код действительно погашен.

Тело необязательно: без заголовка `Content-Type` запроса без тела хост ведёт себя как раньше, так что вебвью плана 1c3, который тела не шлёт, продолжает работать. Для этого `ApiJson` получает реализацию `OptionalFromRequest`: `Option<ApiJson<T>>` — «нет тела», а тело JSON разбирается строго (`deny_unknown_fields`), и его отказ — `validation_failed`, как у остальных.

Ответ меняет форму, поэтому по правилу протокола (`AGENTS.md`, «Protocol») вместе с `proto` и фикстурой меняется схема Zod `pairingCodeSchema`: тест Vitest «parses without losing a field» читает `pairing-code.json`. Экран кода этих полей пока не читает — его доработает план 1d3; здесь меняются только схема и три литерала `PairingCode` в `test/devices-page.test.tsx`, без которых не сойдутся типы. Хостовый тест читает `pairing-code.json` и сверяет его `payload` и срок жизни с кодом хоста (отложено с плана 1c3): фикстура и хост больше не разойдутся.

**Files:**

- Create: `apps/standalone/proto/fixtures/pairing-code-request.json`
- Modify: `apps/standalone/host/src/{error,pairing_code}.rs`, `apps/standalone/host/src/routes/pairing.rs`, `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/fixtures/pairing-code.json`, `apps/standalone/src/host/protocol.ts`
- Test: `apps/standalone/host/tests/pairing_codes.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/devices-page.test.tsx`
- Modify: `apps/standalone/AGENTS.md` («Local pairing trust»), спецификация §4.5, §4.7

**Interfaces:**

- Consumes:
  - `pairing_code::{generate, payload, CODE_LIFETIME, MAX_FAILED_ATTEMPTS}`, `claim` (план 1c1);
  - `clock::{format_timestamp, parse_timestamp}`;
  - `OptionalFromRequest` — axum 0.8.9 (`Option<Json<T>>`: без `Content-Type` — `None`).
- Produces:
  - `impl OptionalFromRequest<S> for ApiJson<T>` — `host/src/error.rs`;
  - `PairingCode { id, code, created_at, expires_at, payload }`, `PairingCodeRequest { replaces: Option<String> }` — `proto/src/lib.rs`;
  - `pairingCodeSchema` с `id: z.uuid()` и `createdAt: z.iso.datetime()` — `src/host/protocol.ts`.

- [ ] **Step 1: Тесты (падающие)**

1. Заменить содержимое `apps/standalone/proto/fixtures/pairing-code.json` целиком:

```json
{
  "id": "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
  "code": "7K3MQ9XV2D",
  "createdAt": "2026-09-26T09:15:00Z",
  "expiresAt": "2026-09-26T09:25:00Z",
  "payload": "markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D"
}
```

2. Create `apps/standalone/proto/fixtures/pairing-code-request.json`:

```json
{ "replaces": "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d" }
```

3. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn pairing_code_fixture_round_trips_without_leaking() {
    let code: PairingCode = round_trip("pairing-code.json");
    let debug = format!("{code:?}");
    assert!(!debug.contains(code.code.expose()), "{debug}");
    assert!(!debug.contains("markiro-host:1"), "{debug}");
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn pairing_code_fixture_round_trips_without_leaking() {
    let code: PairingCode = round_trip("pairing-code.json");
    assert_eq!(code.created_at, "2026-09-26T09:15:00Z");
    let debug = format!("{code:?}");
    assert!(!debug.contains(code.code.expose()), "{debug}");
    assert!(!debug.contains("markiro-host:1"), "{debug}");
}

#[test]
fn a_pairing_code_request_is_optional_and_strict() {
    let request: PairingCodeRequest = round_trip("pairing-code-request.json");
    let code: PairingCode = serde_json::from_value(fixture("pairing-code.json")).unwrap();
    assert_eq!(request.replaces, Some(code.id));
    let empty: PairingCodeRequest = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(empty.replaces, None);
    assert_eq!(serde_json::to_value(&empty).unwrap(), serde_json::json!({}));
    let mut value = fixture("pairing-code-request.json");
    value["code"] = Value::String("7K3MQ9XV2D".into());
    assert!(serde_json::from_value::<PairingCodeRequest>(value).is_err());
}
```

4. Там же фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, ChangesResponse, ClaimRequest, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LineCreate, LineRecord,
    LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PasswordChange, PasswordSet,
    SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, ChangesResponse, ClaimRequest, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LineCreate, LineRecord,
    LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT, PROTOCOL_VERSION,
};
```

5. В `apps/standalone/host/src/pairing_code.rs` фрагмент

<!-- prettier-ignore -->
```rust
    use super::{generate, payload, ALPHABET, CODE_LENGTH};
```

заменить на

<!-- prettier-ignore -->
```rust
    use super::{generate, payload, ALPHABET, CODE_LENGTH, CODE_LIFETIME};
    use crate::clock::{format_timestamp, parse_timestamp};

    /// The shared fixture is what this host answers: the payload it builds
    /// for the fixture's code, and a lifetime of `CODE_LIFETIME` from
    /// `createdAt` to `expiresAt`.
    #[test]
    fn the_shared_pairing_code_fixture_matches_the_host() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/pairing-code.json")).unwrap();
        let text = |key: &str| fixture[key].as_str().unwrap().to_owned();
        assert_eq!(
            payload(
                &[Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)],
                45710,
                &"ab".repeat(32),
                &text("code"),
            ),
            text("payload")
        );
        let created = parse_timestamp(&text("createdAt")).unwrap();
        assert_eq!(format_timestamp(created + CODE_LIFETIME), text("expiresAt"));
    }
```

6. В `apps/standalone/host/tests/pairing_codes.rs` фрагмент

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, login, pair_device, request, seed_office_user, test_fingerprint, with_device,
    with_session, TestApp,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, seed_office_user,
    test_fingerprint, with_device, with_session, TestApp, LAN,
};
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let admin = admin_id(&app).await;
    assert_eq!(code_hash, key_hash(&code));
```

заменить на

<!-- prettier-ignore -->
```rust
    let admin = admin_id(&app).await;
    assert_eq!(
        (body["id"].clone(), body["createdAt"].clone()),
        (json!(id), json!(created_at))
    );
    assert_eq!(code_hash, key_hash(&code));
```

8. Там же, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(count, 0);
    assert!(code_audit(&app).await.is_empty());
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(count, 0);
    assert!(code_audit(&app).await.is_empty());
}

/// A new code for the session `token`, replacing `replaces` if given.
async fn issue(app: &TestApp, key: &str, token: &str, replaces: Option<&str>) -> Value {
    let builder = with_session(request("POST", "/v1/office/pairing-codes"), key, token);
    let (status, body) = match replaces {
        Some(old) => {
            app.send(json_request(builder, json!({ "replaces": old })))
                .await
        }
        None => app.send(empty(builder)).await,
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["id"].is_string(), "the answer names the code: {body}");
    body
}

async fn claim(app: &TestApp, code: &Value) -> (StatusCode, Value) {
    app.send_from(
        LAN,
        json_request(
            request("POST", "/v1/pairing/claim"),
            json!({ "code": code["code"], "kind": "station", "name": "Станция 2", "appVersion": "0.1.0" }),
        ),
    )
    .await
}

/// `details` of the `pairing_code.create` row of the code `id`.
async fn created_details(app: &TestApp, id: &Value) -> Value {
    let row = code_audit(app)
        .await
        .into_iter()
        .find(|row| row.4.as_deref() == id.as_str())
        .unwrap();
    serde_json::from_str(&row.6).unwrap()
}

#[tokio::test]
async fn a_new_code_replaces_the_administrators_previous_one() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let first = issue(&app, &key, &token, None).await;
    let second = issue(&app, &key, &token, first["id"].as_str()).await;
    assert_ne!(second["id"], first["id"]);

    // The replaced code is refused as expired; the new one pairs.
    let (status, body) = claim(&app, &first).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_expired"))
    );
    let reason: String = sqlx::query_scalar(
        "SELECT json_extract(details, '$.reason') FROM audit_log \
         WHERE action = 'device.claim' AND result = 'denied'",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(reason, "code_expired");
    let (status, body) = claim(&app, &second).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let admin = admin_id(&app).await;
    let rows = code_audit(&app).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (
            rows[1].0.as_str(),
            rows[1].1.as_deref(),
            rows[1].2.as_str(),
            rows[1].3.as_deref(),
            rows[1].4.as_deref(),
            rows[1].5.as_str()
        ),
        (
            "office_user",
            Some(admin.as_str()),
            "pairing_code.create",
            Some("pairing_code"),
            second["id"].as_str(),
            "ok"
        )
    );
    assert_eq!(
        created_details(&app, &second["id"]).await,
        json!({ "expiresAt": second["expiresAt"], "replaces": first["id"] })
    );
}

#[tokio::test]
async fn a_replaces_naming_no_live_code_of_this_administrator_is_ignored() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let used = issue(&app, &key, &token, None).await;
    assert_eq!(claim(&app, &used).await.0, StatusCode::OK);
    let expired = issue(&app, &key, &token, None).await;
    app.clock.advance(time::Duration::minutes(10));
    seed_office_user(&app, "admin2", "admin", "second admin password").await;
    let other_token = login(&app, &key, "admin2", "second admin password").await;
    let theirs = issue(&app, &key, &other_token, None).await;

    // Another administrator's code, a used one, an expired one and an
    // unknown id: a new code every time, and nothing replaced.
    for old in [
        theirs["id"].as_str().unwrap(),
        used["id"].as_str().unwrap(),
        expired["id"].as_str().unwrap(),
        "9b2e4a6c-0000-4000-8000-000000000000",
    ] {
        let issued = issue(&app, &key, &token, Some(old)).await;
        assert_eq!(
            created_details(&app, &issued["id"]).await,
            json!({ "expiresAt": issued["expiresAt"] }),
            "{old}"
        );
    }
    // The other administrator's code still pairs.
    let (status, body) = claim(&app, &theirs).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_code_request_body_is_optional_but_strict() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let builder = || with_session(request("POST", "/v1/office/pairing-codes"), &key, &token);
    let (status, body) = app.send(json_request(builder(), json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = app
        .send(json_request(builder(), json!({ "replace": body["id"] })))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_codes")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
```

9. В `apps/standalone/test/devices-page.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
function pairingCode(secondsAgo: number, hosts = "10.0.0.5,192.168.1.10"): PairingCode {
  return {
    code: "7K3MQ9XV2D",
    expiresAt: new Date(Date.now() + (600 - secondsAgo) * 1000).toISOString(),
```

заменить на

<!-- prettier-ignore -->
```tsx
function pairingCode(secondsAgo: number, hosts = "10.0.0.5,192.168.1.10"): PairingCode {
  return {
    id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
    code: "7K3MQ9XV2D",
    createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    expiresAt: new Date(Date.now() + (600 - secondsAgo) * 1000).toISOString(),
```

10. Там же фрагмент

<!-- prettier-ignore -->
```tsx
    const code: PairingCode = {
      code: "7K3MQ9XV2D",
      expiresAt: "2026-09-27T10:00:00.000Z",
```

заменить на

<!-- prettier-ignore -->
```tsx
    const code: PairingCode = {
      id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
      code: "7K3MQ9XV2D",
      createdAt: "2026-09-27T09:50:00.000Z",
      expiresAt: "2026-09-27T10:00:00.000Z",
```

11. Там же фрагмент

<!-- prettier-ignore -->
```tsx
    const secondCode: PairingCode = {
      code: "AAAAABBBBB",
      expiresAt: pairingCode(0).expiresAt,
```

заменить на

<!-- prettier-ignore -->
```tsx
    const secondCode: PairingCode = {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      code: "AAAAABBBBB",
      createdAt: pairingCode(0).createdAt,
      expiresAt: pairingCode(0).expiresAt,
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pairing_codes --offline`
Expected: FAIL — 4 теста из 6: в ответе нет `id` (`left: (Null, Null)` у первого теста, `the answer names the code` у `issue`), а тело с лишним полем хост пока не читает (`left: (200, Null)`, `right: (400, String("validation_failed"))`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib pairing_code --offline`
Expected: PASS — 3 теста: новый тест фикстуры проходит сразу, он закрепляет то, что хост уже отвечает.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_proto::PairingCodeRequest` `` и ``error[E0609]: no field `created_at` on type `PairingCode` `` (то же для `id`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/devices-page.test.tsx test/pairing-code.test.ts`
Expected: FAIL — 1 тест из 90: «response fixture pairing-code.json › parses without losing a field» (`id` и `createdAt` схема отбросила).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
Expected: FAIL — `test/devices-page.test.tsx`: три `error TS2353: Object literal may only specify known properties, and 'id' does not exist in type …` и `error TS2339: Property 'createdAt' does not exist on type …` у `pairingCode(0).createdAt`.

- [ ] **Step 3: Необязательное тело, замена кода и ответ с `id`**

1. В `apps/standalone/host/src/error.rs`, после `impl<S, T> FromRequest<S> for ApiJson<T>`, фрагмент

<!-- prettier-ignore -->
```rust
/// `Path<T>` whose rejections become `validation_failed`.
```

заменить на

<!-- prettier-ignore -->
```rust
/// An optional JSON body: without a `Content-Type` header there is none
/// (`None`); with one, the body must parse, and its rejections become
/// `validation_failed` like `ApiJson`'s.
impl<S, T> axum::extract::OptionalFromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Option<Self>, Self::Rejection> {
        match <Json<T> as axum::extract::OptionalFromRequest<S>>::from_request(request, state).await
        {
            Ok(value) => Ok(value.map(|Json(value)| Self(value))),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

/// `Path<T>` whose rejections become `validation_failed`.
```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
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

заменить на

<!-- prettier-ignore -->
```rust
/// `POST /v1/office/pairing-codes`: a one-time code for pairing another
/// device. The code and the payload carrying it are shown once; `id` is what
/// «Новый код» sends as `replaces`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub id: String,
    /// 10 Crockford base32 characters.
    pub code: Secret,
    pub created_at: String,
    pub expires_at: String,
    /// `markiro-host:1?h=<addresses>&p=<port>&f=<fingerprint>&c=<code>`.
    pub payload: Secret,
}

/// The optional body of `POST /v1/office/pairing-codes`. `replaces` names the
/// code «Новый код» takes over: a live code the same office user created
/// expires at once; anything else is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingCodeRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
}
```

3. В `apps/standalone/host/src/routes/pairing.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    codes, ClaimRequest, DeviceKind, LocalPairRequest, PairResponse, PairingCode, Secret,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    codes, ClaimRequest, DeviceKind, LocalPairRequest, PairResponse, PairingCode,
    PairingCodeRequest, Secret,
};
```

4. Там же фрагмент

<!-- prettier-ignore -->
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
```

заменить на

<!-- prettier-ignore -->
```rust
/// `POST /v1/office/pairing-codes` (administrators): a one-time code for a
/// device in the local network. Only its hash is stored; the code and the
/// payload are returned once. «Новый код» sends `{ replaces: <id> }` (owner
/// decision 2026-09-27): a live code this same office user created expires
/// at once, so a claim with it answers `pairing_code_expired`. Anything else
/// in `replaces` — another user's code, an unknown, used, expired or
/// exhausted one — is ignored, and the new code is issued anyway.
pub async fn create_code(
    State(state): State<AppState>,
    context: OfficeContext,
    request: Option<ApiJson<PairingCodeRequest>>,
) -> Result<Json<PairingCode>, ApiError> {
    context.require_admin()?;
    let replaces = request.and_then(|ApiJson(request)| request.replaces);
    let code = pairing_code::generate();
    let now = state.now();
    let at = format_timestamp(now);
    let expires = format_timestamp(now + pairing_code::CODE_LIFETIME);
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    // Expiring the replaced code now makes a claim refuse it as expired and
    // takes it out of the live codes a wrong guess counts against.
    let replaced = match replaces.as_deref() {
        Some(old) => {
            let expired = sqlx::query(
                "UPDATE pairing_codes SET expires_at = ? WHERE id = ? AND created_by = ? \
                 AND used_at IS NULL AND expires_at > ? AND failed_attempts < ?",
            )
            .bind(&at)
            .bind(old)
            .bind(&context.user.id)
            .bind(&at)
            .bind(pairing_code::MAX_FAILED_ATTEMPTS)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            (expired.rows_affected() == 1).then_some(old)
        }
        None => None,
    };
    sqlx::query(
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
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

заменить на

<!-- prettier-ignore -->
```rust
            action: actions::PAIRING_CODE_CREATE,
            target_type: Some("pairing_code"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: match replaced {
                Some(old) => json!({ "expiresAt": expires, "replaces": old }),
                None => json!({ "expiresAt": expires }),
            },
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
        id,
        code: Secret::new(code),
        created_at: at,
        expires_at: expires,
        payload: Secret::new(payload),
    }))
}
```

6. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
/** `POST /v1/office/pairing-codes`: a one-time code; the payload is what the DataMatrix encodes. */
export const pairingCodeSchema = z.object({
  code: z.string().regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`)),
  expiresAt: z.iso.datetime(),
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * `POST /v1/office/pairing-codes`: a one-time code; the payload is what the DataMatrix encodes.
 * `id` is what «Новый код» sends as `replaces`, and `createdAt` starts the code's lifetime.
 */
export const pairingCodeSchema = z.object({
  id: z.uuid(),
  code: z.string().regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`)),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pairing_codes --test claim --offline`
Expected: PASS — 6 и 8 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 27 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/devices-page.test.tsx test/pairing-code.test.ts`
Expected: PASS — 90 тестов (48, 17 и 25).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
Expected: без ошибок.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «Local pairing trust», фрагмент

<!-- prettier-ignore -->
```text
and dies after 5 failed claims — a wrong code counts against every live code,
since the hash cannot tell which one was meant. The claiming device pins the
```

заменить на

<!-- prettier-ignore -->
```text
and dies after 5 failed claims — a wrong code counts against every live code,
since the hash cannot tell which one was meant. The answer carries the code's
`id` and `createdAt`. «Новый код» sends the previous `id` as `{ replaces }`,
and a live code the same administrator created then expires at once: a claim
with it answers `pairing_code_expired`. A `replaces` that names anything else
— another administrator's code, an unknown, used, expired or exhausted one —
is ignored, and the new code is issued anyway; without a body (no
`Content-Type`) nothing is replaced. The claiming device pins the
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §4.5, фрагмент

<!-- prettier-ignore -->
```text
- устройства — `device-update.json` (`PUT` меняет только присланные `name` и
  `lineId`; `lineId: null` снимает линию); ответ `PUT` и отзыва —
  `device-record.json`.
```

заменить на

<!-- prettier-ignore -->
```text
- устройства — `device-update.json` (`PUT` меняет только присланные `name` и
  `lineId`; `lineId: null` снимает линию); ответ `PUT` и отзыва —
  `device-record.json`;
- коды подключения — `pairing-code.json` (ответ с `id` и `createdAt`),
  `pairing-code-request.json` (необязательное тело `{ replaces }`).
```

3. Там же, §4.7, фрагмент

<!-- prettier-ignore -->
```text
- `POST /v1/office/pairing-codes` возвращает `{ code, expiresAt, payload }`, где
  `payload` — строка `markiro-host:1?h=<адрес1,адрес2>&p=<порт>&f=<отпечаток>&c=<код>`
  со всеми адресами IPv4 хоста в локальной сети. Офис рисует её DataMatrix-кодом
  (`renderLiteralDataMatrixSvg` из `@markiro/domain`) и показывает код и таймер.
```

заменить на

<!-- prettier-ignore -->
```text
- `POST /v1/office/pairing-codes` возвращает `{ id, code, createdAt, expiresAt, payload }`, где
  `payload` — строка `markiro-host:1?h=<адрес1,адрес2>&p=<порт>&f=<отпечаток>&c=<код>`
  со всеми адресами IPv4 хоста в локальной сети. Офис рисует её DataMatrix-кодом
  (`renderLiteralDataMatrixSvg` из `@markiro/domain`) и показывает код и таймер.
- «Новый код» гасит прежний (решение владельца 2026-09-27): запрос несёт
  необязательное тело `{ replaces: <id прежнего кода> }`. Живой код, созданный тем
  же администратором, сразу истекает, и `claim` с ним отвечает
  `pairing_code_expired`: код был настоящим и перестал действовать, а не набран с
  ошибкой. `replaces`, который называет что-то другое (код другого администратора,
  неизвестный, использованный, истёкший или исчерпавший попытки), хост пропускает и
  всё равно выдаёт новый код: «Новый код» работает и после того, как прежний код
  умер сам. Строка журнала `pairing_code.create` нового кода несёт `replaces`, только
  если код действительно погашен; коды других администраторов не трогаются никогда.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/pairing-code.json apps/standalone/proto/fixtures/pairing-code-request.json apps/standalone/src/host/protocol.ts apps/standalone/test/devices-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без предупреждений и ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 29 файлов, 531 тест (число тестов Vitest не меняется).

```bash
git add apps/standalone/host/src/error.rs apps/standalone/host/src/pairing_code.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/tests/pairing_codes.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/pairing-code.json apps/standalone/proto/fixtures/pairing-code-request.json apps/standalone/src/host/protocol.ts apps/standalone/test/devices-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): новый код подключения гасит прежний, ответ кода с id и createdAt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Отложенные мелочи хоста — `FromStr` у ролей и видов устройств, общий хеш пароля, тесты `validate.rs`, общая поддержка тестов

Пункты, отложенные с планов 1b1–1c2 и проверенные по коду:

- Роль офиса и вид устройства читаются из базы через `serde_json::from_value(Value::String(…))` в шести местах. `proto` получает `FromStr` для `OfficeRole` и `DeviceKind` с ошибкой `UnknownVariant`; тест `proto` закрепляет, что имена `as_str`, `FromStr` и serde одни и те же.
- Хеширование пароля вне потоков async повторено в `office_users.rs` и `bootstrap.rs`; общим становится `secrets::hash_password_blocking`. Смена своего пароля (`office_auth.rs`) проверяет старый пароль и считает новый в одном `spawn_blocking` и остаётся как есть.
- У прежних проверок `validate.rs` появляются модульные тесты: логин офиса, имя человека, пароль, часовой пояс организации, имя линии, номера SSCC, регистрация устройства. Новые проверки задач 2–6 получили тесты в своих задачах. Эти тесты проходят сразу: они закрепляют то, что хост уже делает.
- Интеграционные тесты, написанные до задачи 2, переходят на общую поддержку `tests/support/app.rs`: `office_admin.rs` берёт `Admin` и `admin()`, `device_line.rs` и `claim.rs` — `audit_trail` и `AuditRow`, `changes_stream.rs`, `device_line.rs` и `office_auth.rs` — `host_revision`. Помощники с другой формой (`code_audit` в `pairing_codes.rs`, `password_audit` в `office_auth.rs` с `details` строкой, `audit_rows` в `pairing.rs` со временем) остаются: общий помощник их не заменяет без правки проверок.
- `office_user.update` с `{ from, to }` для роли и активности уже сделан в плане 1c1 (`audit::update_details`), тест хоста для `pairing-code.json` — в задаче 7. Эти пункты сняты.

Поведение хоста задача не меняет: коды ошибок, ответы и строки журнала прежние.

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/src/{auth,secrets}.rs`, `apps/standalone/host/src/routes/{devices,office_auth,office_users,bootstrap}.rs`, `apps/standalone/host/src/validate.rs`
- Test: `apps/standalone/host/tests/{office_admin,device_line,claim,changes_stream,office_auth}.rs`
- Modify: `apps/standalone/AGENTS.md` («Verification»)

**Interfaces:**

- Consumes:
  - `DeviceKind::as_str`, `OfficeRole::as_str` — `proto/src/lib.rs`;
  - `secrets::hash_password`;
  - `Admin`, `admin`, `audit_trail`, `AuditRow`, `host_revision` — `host/tests/support/app.rs` (задача 2).
- Produces:
  - `pub struct UnknownVariant(pub String)` (`Display`, `Error`), `impl FromStr for DeviceKind`, `impl FromStr for OfficeRole` — `proto/src/lib.rs`;
  - `pub async fn secrets::hash_password_blocking(password: Secret) -> Result<String, tokio::task::JoinError>`.

- [ ] **Step 1: Тесты — падающий тест `proto` и перевод прежних тестов на общую поддержку**

1. В `apps/standalone/proto/src/lib.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSalt {
    pub badge_salt: Secret,
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSalt {
    pub badge_salt: Secret,
}

#[cfg(test)]
mod tests {
    use super::{DeviceKind, OfficeRole, UnknownVariant};

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
    fn stored_names_parse_back_into_their_variants() {
        for kind in [
            DeviceKind::Station,
            DeviceKind::Office,
            DeviceKind::Handheld,
        ] {
            assert_eq!(kind.as_str().parse::<DeviceKind>(), Ok(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        for role in [OfficeRole::Admin, OfficeRole::Technologist] {
            assert_eq!(role.as_str().parse::<OfficeRole>(), Ok(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        assert_eq!(
            "Station".parse::<DeviceKind>(),
            Err(UnknownVariant("Station".to_owned()))
        );
        assert_eq!(
            "owner".parse::<OfficeRole>(),
            Err(UnknownVariant("owner".to_owned()))
        );
    }
}
```

2. В `apps/standalone/host/src/validate.rs`, в модуле `tests`, фрагмент

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_personnel_number_is_3_to_12_ascii_digits() {
```

заменить на

<!-- prettier-ignore -->
```rust
    #[test]
    fn an_office_login_is_3_to_64_latin_letters_digits_dots_underscores_or_hyphens() {
        let longest = "a".repeat(64);
        for login in ["adm", "i.smirnova", "tech_1", "a-b", longest.as_str()] {
            assert!(office_login("login", login).is_ok(), "{login}");
        }
        let too_long = "a".repeat(65);
        for login in ["ad", too_long.as_str(), "ирина", "a b", "a@b"] {
            assert_eq!(field(office_login("login", login)), "login", "{login}");
        }
    }

    #[test]
    fn a_person_name_is_trimmed_to_1_to_100_characters() {
        assert_eq!(person_name("name", " Ирина ").unwrap(), "Ирина");
        assert!(person_name("name", &"и".repeat(100)).is_ok());
        assert_eq!(field(person_name("name", "  ")), "name");
        assert_eq!(field(person_name("name", &"и".repeat(101))), "name");
    }

    #[test]
    fn a_password_is_8_to_128_characters() {
        assert!(password("password", "12345678").is_ok());
        assert!(password("password", &"п".repeat(128)).is_ok());
        assert_eq!(field(password("password", "1234567")), "password");
        assert_eq!(field(password("password", &"п".repeat(129))), "password");
    }

    #[test]
    fn the_organization_adds_a_time_zone_to_the_company_fields() {
        let input = |time_zone: &str| OrgProfileInput {
            name: "ООО «Атолл»".to_owned(),
            inn: None,
            gln: GLN.to_owned(),
            gs1_prefixes: vec![],
            time_zone: time_zone.to_owned(),
        };
        assert_eq!(
            org("org", &input(" Europe/Moscow ")).unwrap().time_zone,
            "Europe/Moscow"
        );
        assert!(org("", &input("Etc/GMT+3")).is_ok());
        assert_eq!(field(org("org", &input(""))), "org.timeZone");
        assert_eq!(field(org("", &input("Europe Moscow"))), "timeZone");
        assert_eq!(field(org("org", &input_named(""))), "org.name");
    }

    fn input_named(name: &str) -> OrgProfileInput {
        OrgProfileInput {
            name: name.to_owned(),
            inn: None,
            gln: GLN.to_owned(),
            gs1_prefixes: vec![],
            time_zone: "Europe/Moscow".to_owned(),
        }
    }

    #[test]
    fn a_line_name_comes_with_its_unicode_lower_case_key() {
        assert_eq!(
            line_name("lines.0", " Линия 1 ").unwrap(),
            ("Линия 1".to_owned(), "линия 1".to_owned())
        );
        assert_eq!(field(line_name("lines.0", " ")), "lines.0");
        assert_eq!(field(line_name("name", &"л".repeat(101))), "name");
    }

    #[test]
    fn an_sscc_serial_lies_between_the_first_serial_and_the_capacity() {
        assert_eq!(issuer_prefix(GLN), "460123400");
        assert_eq!(serial_capacity("460123400"), 10_000_000);
        assert_eq!((first_serial(0), first_serial(1)), (1, 0));
        assert!(sscc_serial("sscc.boxNextSerial", 0, "460123400", 1).is_ok());
        assert!(sscc_serial("sscc.palletNextSerial", 1, "460123400", 0).is_ok());
        assert!(sscc_serial("nextSerial", 0, "460123400", 9_999_999).is_ok());
        assert_eq!(
            field(sscc_serial("sscc.boxNextSerial", 0, "460123400", 0)),
            "sscc.boxNextSerial"
        );
        assert_eq!(
            field(sscc_serial("nextSerial", 1, "460123400", 10_000_000)),
            "nextSerial"
        );
    }

    #[test]
    fn a_device_registration_checks_its_version_and_capabilities() {
        assert_eq!(
            device_registration(" Станция ", " 0.1.0 ", &["scanner".to_owned()]).unwrap(),
            ("Станция", "0.1.0")
        );
        assert_eq!(
            field(device_registration("Станция", " ", &[])),
            "appVersion"
        );
        assert_eq!(
            field(device_registration("Станция", &"1".repeat(51), &[])),
            "appVersion"
        );
        assert_eq!(
            field(device_registration("Станция", "0.1.0", &[String::new()])),
            "capabilities"
        );
        let many: Vec<String> = (0..33).map(|n| format!("c{n}")).collect();
        assert_eq!(
            field(device_registration("Станция", "0.1.0", &many)),
            "capabilities"
        );
    }

    #[test]
    fn a_personnel_number_is_3_to_12_ascii_digits() {
```

3. В `apps/standalone/host/tests/office_admin.rs` фрагмент

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, with_session, TestApp,
};

struct Admin {
    app: TestApp,
    key: String,
    token: String,
    id: String,
}

async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (status, me) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let id = me["id"].as_str().unwrap().to_owned();
    Admin {
        app,
        key,
        token,
        id,
    }
}

impl Admin {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let builder = with_session(request(method, path), &self.key, &self.token);
        match body {
            Some(body) => self.app.send(json_request(builder, body)).await,
            None => self.app.send(empty(builder)).await,
        }
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
use support::app::{
    admin, empty, json as json_request, login, pair_device, request, with_session, Admin,
};

```

4. В `apps/standalone/host/tests/device_line.rs` фрагмент

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, seed_office_user,
    with_device, with_session, TestApp,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use support::app::{
    audit_trail, bootstrap, empty, host_revision, json as json_request, login, pair_device,
    request, seed_office_user, with_device, with_session, AuditRow, TestApp,
};
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Value,
);

async fn line_audit(app: &TestApp) -> Vec<AuditRow> {
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'device.line' ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(
            |(kind, id, action, target_type, target_id, result, details)| {
                (
                    kind,
                    id,
                    action,
                    target_type,
                    target_id,
                    result,
                    serde_json::from_str(&details).unwrap(),
                )
            },
        )
        .collect()
}

async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

```

заменить на

<!-- prettier-ignore -->
```rust
async fn line_audit(app: &TestApp) -> Vec<AuditRow> {
    audit_trail(app, "device.line").await
}

```

6. В `apps/standalone/host/tests/claim.rs` фрагмент

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, json as json_request, pair_device, request, with_device, with_session,
    TestApp, LAN, LOOPBACK,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use support::app::{
    audit_trail, bootstrap, empty, json as json_request, pair_device, request, with_device,
    with_session, AuditRow, TestApp, LAN, LOOPBACK,
};
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Value,
);

async fn claim_audit(app: &TestApp) -> Vec<AuditRow> {
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'device.claim' ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(
            |(kind, id, action, target_type, target_id, result, details)| {
                (
                    kind,
                    id,
                    action,
                    target_type,
                    target_id,
                    result,
                    serde_json::from_str(&details).unwrap(),
                )
            },
        )
        .collect()
}

```

заменить на

<!-- prettier-ignore -->
```rust
async fn claim_audit(app: &TestApp) -> Vec<AuditRow> {
    audit_trail(app, "device.claim").await
}

```

8. В `apps/standalone/host/tests/changes_stream.rs` фрагмент

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, json as json_request, pair_device, request, with_device, with_session,
    TestApp, LOOPBACK,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use support::app::{
    bootstrap, empty, host_revision, json as json_request, pair_device, request, with_device,
    with_session, TestApp, LOOPBACK,
};
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_stream_sends_the_current_revision_then_every_new_one() {
```

заменить на

<!-- prettier-ignore -->
```rust
#[tokio::test]
async fn the_stream_sends_the_current_revision_then_every_new_one() {
```

10. В `apps/standalone/host/tests/office_auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
use support::app::{
    empty, json as json_request, login, pair_device, request, seed_office_user, with_device,
    with_session, TestApp, LAN, LOOPBACK,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use support::app::{
    empty, host_revision, json as json_request, login, pair_device, request, seed_office_user,
    with_device, with_session, TestApp, LAN, LOOPBACK,
};
```

11. Там же фрагмент

<!-- prettier-ignore -->
```rust
async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

type AuditRow = (
```

заменить на

<!-- prettier-ignore -->
```rust
type AuditRow = (
```

- [ ] **Step 2: Запустить тесты — падает только тест `proto`**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --lib --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `super::UnknownVariant` ``; `parse::<DeviceKind>()` и `parse::<OfficeRole>()` тоже не собираются (``error[E0277]: the trait bound `DeviceKind: FromStr` is not satisfied``).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: PASS — 15 тестов (8 прежних и 7 новых): новые тесты закрепляют прежние проверки.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_admin --test device_line --test claim --test office_auth --offline`
Expected: PASS — 8, 4, 8 и 16 тестов: прежние тесты на общей поддержке проходят как раньше.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream --offline`
Expected: PASS — 8 тестов.

- [ ] **Step 3: `FromStr` и общий хеш пароля**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::Station => "station",
            DeviceKind::Office => "office",
            DeviceKind::Handheld => "handheld",
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::Station => "station",
            DeviceKind::Office => "office",
            DeviceKind::Handheld => "handheld",
        }
    }
}

/// A stored name that is no variant of the enum it was read as
/// ([`DeviceKind`], [`OfficeRole`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownVariant(pub String);

impl std::fmt::Display for UnknownVariant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "unknown value {:?}", self.0)
    }
}

impl std::error::Error for UnknownVariant {}

impl std::str::FromStr for DeviceKind {
    type Err = UnknownVariant;

    /// The name [`DeviceKind::as_str`] gives, as `devices.kind` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "station" => Ok(DeviceKind::Station),
            "office" => Ok(DeviceKind::Office),
            "handheld" => Ok(DeviceKind::Handheld),
            other => Err(UnknownVariant(other.to_owned())),
        }
    }
}
```

2. Там же фрагмент

<!-- prettier-ignore -->
```rust
impl OfficeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            OfficeRole::Admin => "admin",
            OfficeRole::Technologist => "technologist",
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
impl OfficeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            OfficeRole::Admin => "admin",
            OfficeRole::Technologist => "technologist",
        }
    }
}

impl std::str::FromStr for OfficeRole {
    type Err = UnknownVariant;

    /// The name [`OfficeRole::as_str`] gives, as `office_users.role` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "admin" => Ok(OfficeRole::Admin),
            "technologist" => Ok(OfficeRole::Technologist),
            other => Err(UnknownVariant(other.to_owned())),
        }
    }
}
```

3. В `apps/standalone/host/src/auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
        let kind: DeviceKind =
            serde_json::from_value(serde_json::Value::String(kind)).map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
        let kind: DeviceKind = kind.parse().map_err(ApiError::internal)?;
```

4. Там же фрагмент

<!-- prettier-ignore -->
```rust
        serde_json::from_value(serde_json::Value::String(role)).map_err(ApiError::internal)
    }
```

заменить на

<!-- prettier-ignore -->
```rust
        role.parse().map_err(ApiError::internal)
    }
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
        let role: OfficeRole =
            serde_json::from_value(serde_json::Value::String(role)).map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
        let role: OfficeRole = role.parse().map_err(ApiError::internal)?;
```

6. В `apps/standalone/host/src/routes/devices.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let kind: DeviceKind =
        serde_json::from_value(serde_json::Value::String(row.kind)).map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
```

7. В `apps/standalone/host/src/routes/office_auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
            let role: OfficeRole = serde_json::from_value(serde_json::Value::String(role))
                .map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
            let role: OfficeRole = role.parse().map_err(ApiError::internal)?;
```

8. В `apps/standalone/host/src/secrets.rs` фрагмент

<!-- prettier-ignore -->
```rust
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
```

заменить на

<!-- prettier-ignore -->
```rust
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use markiro_proto::Secret;
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// Hash a password for storage with a fresh random salt.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_BYTES];
    aws_lc_rs::rand::fill(&mut salt).expect("the system random generator is available");
    hash_password_with_salt(password, &salt, PASSWORD_ITERATIONS)
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// Hash a password for storage with a fresh random salt.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_BYTES];
    aws_lc_rs::rand::fill(&mut salt).expect("the system random generator is available");
    hash_password_with_salt(password, &salt, PASSWORD_ITERATIONS)
}

/// [`hash_password`] off the async threads: PBKDF2 at 600 000 iterations
/// takes a noticeable fraction of a second. Call it before `begin_write`.
pub async fn hash_password_blocking(password: Secret) -> Result<String, tokio::task::JoinError> {
    tokio::task::spawn_blocking(move || hash_password(password.expose())).await
}
```

10. В `apps/standalone/host/src/routes/office_users.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    codes, OfficeRole, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, PasswordSet, Secret,
};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    codes, OfficeRole, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, PasswordSet,
};
```

11. Там же фрагмент

<!-- prettier-ignore -->
```rust
use crate::secrets::hash_password;
```

заменить на

<!-- prettier-ignore -->
```rust
use crate::secrets::hash_password_blocking;
```

12. Там же фрагмент

<!-- prettier-ignore -->
```rust
        role: serde_json::from_value(serde_json::Value::String(role))
            .map_err(ApiError::internal)?,
```

заменить на

<!-- prettier-ignore -->
```rust
        role: role.parse().map_err(ApiError::internal)?,
```

13. Там же (функция `hash` уходит) фрагмент

<!-- prettier-ignore -->
```rust
async fn hash(password: Secret) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(password.expose()))
        .await
        .map_err(ApiError::internal)
}

/// The write tail shared by an admin resetting another user's password
```

заменить на

<!-- prettier-ignore -->
```rust
/// The write tail shared by an admin resetting another user's password
```

14. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let password_phc = hash(create.password).await?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let password_phc = hash_password_blocking(create.password)
        .await
        .map_err(ApiError::internal)?;
```

15. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let password_phc = hash(body.password).await?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let password_phc = hash_password_blocking(body.password)
        .await
        .map_err(ApiError::internal)?;
```

16. В `apps/standalone/host/src/routes/bootstrap.rs` фрагмент

<!-- prettier-ignore -->
```rust
use crate::secrets::hash_password;
```

заменить на

<!-- prettier-ignore -->
```rust
use crate::secrets::hash_password_blocking;
```

17. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let password = request.admin.password.clone();
    let password_phc = tokio::task::spawn_blocking(move || hash_password(password.expose()))
        .await
        .map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let password_phc = hash_password_blocking(request.admin.password.clone())
        .await
        .map_err(ApiError::internal)?;
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 3 модульных теста и 27 тестов фикстур.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --test bootstrap --test office_admin --test office_auth --test pairing --test devices --offline`
Expected: PASS — 34, 6, 8, 16, 6 и 6 тестов.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «Verification», фрагмент

<!-- prettier-ignore -->
```text
  Tauri crate needs `apps/standalone/dist`: build the webview first with
  `pnpm turbo run build --filter='@markiro/standalone...'`.
```

заменить на

<!-- prettier-ignore -->
```text
  Tauri crate needs `apps/standalone/dist`: build the webview first with
  `pnpm turbo run build --filter='@markiro/standalone...'`.
- Host integration tests share `host/tests/support/app.rs`: `admin()` is a
  host after the wizard with its administrator signed in on the station that
  ran it (`Admin::call`, `call_as`, `technologist`), `audit_trail` reads the
  exact audit rows of one action and `Admin::row` builds the expected `ok`
  row, `host_revision` reads the revision. Add a helper there before copying
  one into a second test file.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`; `git diff --check`
Expected: чисто.

Run: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`, затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: PASS — 35 наборов, 293 теста, без предупреждений компилятора.

```bash
git add apps/standalone/proto/src/lib.rs apps/standalone/host/src/auth.rs apps/standalone/host/src/secrets.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/routes/devices.rs apps/standalone/host/src/routes/office_auth.rs apps/standalone/host/src/routes/office_users.rs apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/tests/office_admin.rs apps/standalone/host/tests/device_line.rs apps/standalone/host/tests/claim.rs apps/standalone/host/tests/changes_stream.rs apps/standalone/host/tests/office_auth.rs apps/standalone/AGENTS.md
git commit -m "refactor(standalone): FromStr ролей и видов устройств, общий хеш пароля, тесты validate и общая поддержка тестов хоста" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build` — зелёные; Vitest — 29 файлов, 531 тест.
- [ ] `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'` (крейт оболочки встраивает `apps/standalone/dist`), затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — 35 наборов, 293 теста (226 до плана), без предупреждений компилятора; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` — без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам — чисто; `git diff --check <начало плана>..HEAD` — чисто.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `apps/station`, `apps/standalone/src-tauri` и `tools/ci/affected.mjs` не менялись.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - новыми маршрутами пока никто не пользуется: экраны офиса и копии операторов и бейджей на станции — планы 1d3 и 1d4, вход по PIN и бейджу — план 1f;
  - отзыв устройства и конец его потока на двух ПК в настоящей сети — вручную после плана 1d3;
  - задание CI `standalone-windows-build` — для него нужен push.

---

## Перенесено

- План 1d3:
  - схемы Zod и проверки Vitest для новых фикстур: `counterparty-*.json`, `office-line.json`, `line-*.json`, `office-operator.json`, `operator-*.json`, `badge-*.json`, `device-update.json`, `pairing-code-request.json`, `changes-people.json`;
  - записи `operators`, `operator_badges` и `site` читаются через `z.strictObject`, `SYNC_SCHEMA_VERSION` поднимается: запись с незнакомым полем уходит в карантин, а не теряет поле;
  - диалог кода подключения шлёт `replaces` с `id` прежнего кода и считает срок от `createdAt` и `expiresAt` хоста вместо своей копии `CODE_LIFETIME_MS`;
  - экран «Устройства» предупреждает, что отзыв своего устройства завершит сессию;
  - копии `ref_operators` и `ref_operator_badges` на станции и их место в бюджете операторов порции (3E + 6).
- План 1f: вход по бейджу требует запись оператора с его `operatorId`. Бейдж проверяется одним расчётом с солью площадки, а не PBKDF2 на каждого оператора, как `verifyOperatorBadge` станции облака.
- План, который пускает смены на линии (2a): что делать со станцией на архивной линии — план 1d2 её не трогает.
- Политика `MIN_PROTOCOL_VERSION` (из «Перенесено» плана 1d1): отвергнутое старое приложение живёт офлайн на своих копиях и не получает надгробий. В бриф плана 1d2 не вошла — решает контроллер (план 1d3 или 5).
- Журнал отказанных записей офиса (`validation_failed`, `forbidden`, `stale_revision`, `conflict`): в плане 1d2 такие запросы строк не пишут, как и прежние писатели. Если владелец захочет их видеть, нужен отдельный план для всех писателей офиса сразу.

---

## Отклонения при исполнении

Записано по итогам исполнения 2026-09-28. Там, где задачи выше расходятся с кодом в ветке, верен этот раздел.

**Поправки плана по ходу исполнения**

- Ожидаемые числа тестов в задачах 6–8 устарели на 1–2: правка ревью задачи 5 добавила тесты уже после того, как план был проверен прогоном. Фактические числа — в отчётах задач.
- Правки задач 7 и 8 опирались на текст, который вносит задача 6 (`DeviceUpdate`, `device-update.json`, форма `let kind: DeviceKind =`): до неё их якоря не совпадали, после — совпали.
- Необязательное укрепление входа из ревью задачи 6 (открывать сессию, только если устройство ещё не отозвано) не сделано: сессия работает лишь вместе с ключом своего устройства, а ключ отозванного отвергается.

**Люди в модели и ленте (задача 1)**

- Как написано.
- Итоговая волна закрыла замечания ревью: тест переноса тумбстоуна вверх, тест «второй тумбстоун переживает возвращение оператора», поиск записи `site` по сущности в тесте прото, скрытый `Debug` конверта ленты.

**Контрагенты и линии (задачи 2–3)**

- Как написано. `validate::company` вынесена из `validate::org`, поэтому правила имени, ИНН, GLN и префиксов у профиля и контрагентов одни.
- Итоговая волна добавила тесты отказов (устаревшая и несуществующая запись не пишут ни ревизию, ни журнал), очистки ИНН, возврата из архива, переименования линии в имя её же регистра и в имя активной линии для архивной, `deny_unknown_fields` у `LineCreate`.
- Порядок списков байтовый (`«Линия 10»` раньше `«Линия 2»`): естественную сортировку делает интерфейс плана 1d3.

**Операторы (задача 4)**

- Потолок числа итераций 10 000–1 000 000 в `parse_phc` действует и на пароли офиса (600 000).
- Сообщение об отказе PIN строится из `MIN_ITERATIONS` и `MAX_ITERATIONS`, а не пишется числом (итоговая волна).

**Бейджи (задача 5)**

- Бейдж принимается только с ровно 100 000 итераций и солью площадки. Ревью нашло дыру: `parse_phc` принимал ведущие нули в числе итераций (`0100000` читалось как 100 000), и такая строка обходила уникальный индекс: одна карта становилась активным бейджем двух операторов, а станция и домен читают число через `Number()`.
- Исправлено в источнике: `parse_phc` не принимает число итераций с ведущим нулём, поэтому каждая принятая строка записана единственным способом. Это касается и PIN, и паролей; то, что пишет сам хост, ведущего нуля не имеет. Читатели на TypeScript (`packages/domain`, станция) по-прежнему читают такое число мягко: хост — единственный писатель хешей бейджей в ленту автономного продукта, и любой будущий второй писатель обязан применить то же правило.

**Устройства (задача 6)**

- Отозванное устройство остаётся в списке и остаётся редактируемым: запись мёртвая (ключ отвергается, возврата из отзыва нет, повторное подключение создаёт новое устройство). Решение о кнопках — за планом 1d3.
- Изменение линии станции берёт одну ревизию хоста без записи в ленте. Итоговое ревью нашло: без ревизии станция не узнаёт о линии, назначенной в офисе, а её следующий выбор молча затирает выбор администратора. Решение контроллера (владелец может его отменить): ревизия берётся только при реальной смене линии, чтобы будить потоки, а переименование и пустая правка ревизию не берут. Подхват линии станцией — задача плана 1d3, взаимодействие со сменой в работе — план 2a. Спецификация §4.4, §4.5 и §4.7 исправлена.
- Повторная отправка текущей линии станции — «оставить как есть», даже если линия в архиве: иначе форма «имя и линия» не давала переименовать такую станцию.

**Коды подключения (задача 7)**

- `replaces` — как решил владелец 2026-09-27: код того же пользователя, ещё живой, заканчивается сразу (`expires_at` равно сейчас, повторная попытка получает `pairing_code_expired`); чужой, неизвестный, использованный, истёкший и исчерпанный код игнорируется, а новый выдаётся всё равно.
- Правка веб-части предусмотрена планом: `pairingCodeSchema` требует `id` и `createdAt`. `PROTOCOL_VERSION` не поднят: продукт не выпущен. После выпуска новое обязательное поле ответа — несовместимое изменение (поднять версию или оставить поле необязательным).
- Веб-приложение пока не шлёт `replaces`: решение владельца станет видно в интерфейсе с плана 1d3.

**Итоговое ревью и его две волны (e119029, 146e8c5, c9f6ecd, 8f8ffa7)**

- Коммит и уведомление неразделимы: `db::commit_and_notify` выполняет коммит и уведомление в одной порождённой задаче, поэтому оборванный запрос (клиент повесил трубку) не теряет пробуждение. `commit_with_revision` — тонкая обёртка над ним, отзыв устройства пользуется им же и будит потоки повторно при повторном отзыве. Сторожевой объект на выходе для ревизий не применяется: он мог бы объявить откатанную ревизию, и `rev > latest` подавил бы настоящий коммит с тем же номером. Тест опрашивает коммит один раз и бросает его, а отдельный тест закрепляет порядок «уведомление только после удачного коммита».
- Тесты уровня маршрута (`host/tests/commit.rs`): запрос отзыва устройства и запрос деактивации оператора, оборванные сразу после коммита (по 20 раундов на свежей записи), всё равно будят потоки и ленту. Если вернуть любую из двух записей к последовательному «коммит, затем уведомление», её тест падает в первом раунде.
- Одно правило для всего свободного текста: `validate.rs` обрезает, считает символы (не байты) и отвергает управляющие символы. Ведущий NUL проходил `str::trim`, а SQLite `length()` останавливается на нём, поэтому проверка таблицы падала и хост отвечал 500; NUL посередине проходил проверку, и два одинаковых на вид названия могли быть активны вместе. Правило действует для названий, ролей, подписей, названий компаний, линий и устройств, версии и возможностей устройства. Возможности проверяются в присланном виде (не обрезаются): всё, что отвергнуто, в базу не попадёт, а пустая после обрезки возможность и `«x\n»` теперь отвергаются.
- Прочее: скрытый `Debug` записи ленты и `SiteRecord.badge_salt` как `Secret` (та же форма на проводе); проверки на этапе компиляции, что числа итераций пароля и бейджа лежат между нижним и верхним пределом; ранний выход, когда различных префиксов больше десяти; общий помощник «нарушение уникальности → `conflict`» (только `is_unique_violation`); `FromStr` для `OfficeRole` и `DeviceKind` через `IntoDeserializer` serde; ошибка разбора называет тип (`unknown office role "x"`); предупреждение в журнале при ошибке перечитывания устройства в потоке (поток при этом заканчивается).
- Правило «Network and TLS» описывает не «учётные данные сессии», а «чужой токен сессии»: веб-приложение держит собственный токен офисной сессии по замыслу (его возвращает `/v1/office/login`).
- Спецификация §4.3: правило часового пояса профиля — как в хосте (1–64 символа из латинских букв, цифр и `/ _ - +`), а не «непустая строка»; правило текстовых полей записано в §4.3 и в `AGENTS.md`.

**Перенесено**

- План 1d3 (приложение):
  - Zod-схемы новых форм проводов: office-line, line-create, line-update, office-operator, operator-create, operator-update, badge-create, badge-salt, device-update, pairing-code-request и записи ленты `operators` и `operator_badges` (`z.strictObject` и подъём `SYNC_SCHEMA_VERSION`);
  - «Новый код» шлёт `{ replaces: <id прежнего кода> }`; таймер берёт срок жизни у хоста как `expiresAt − createdAt` и считает от момента локального запроса, не сравнивая метки хоста с часами этого ПК; кнопка блокируется, пока запрос идёт (двойной щелчок оставляет два живых кода);
  - станция подхватывает назначенную в офисе линию: перечитывает `GET /v1/device` при подключении и при каждом событии ревизии;
  - таблица копий бейджей на станции без внешнего ключа на оператора (лента законно присылает бейджи выключенного оператора, а бейдж может прийти страницей раньше оператора);
  - станция с отозванным (`key_rejected`), отвергнутым или забытым устройством перестаёт принимать вход по PIN и бейджу офлайн (хеши, уже лежащие на диске, отзыв хоста не стирает);
  - хеш бейджа — ровно 100 000 итераций как именованная константа (или хост возвращает `iterations` вместе с солью);
  - формы повторяют правило управляющих символов; контрагенты и линии сортируются естественно; кнопки правки у отозванных устройств выключены;
  - при конфликте бейджа решить, отдавать ли администратору `operatorId` или `badgeId` в `details`; при желании не слать хеши операторов устройствам вида «офис».
- План 1f (вход оператора на станции): бейдж, подходящий нескольким действующим операторам, отвергается как неоднозначный, а не сводится к первому найденному (облачная станция берёт первого).
- План 2a: как назначенная в офисе линия ведёт себя при смене в работе.
- План 5: `MIN_PROTOCOL_VERSION` (отвергнутое старое приложение не должно продолжать вход оператора офлайн по старым копиям: тумбстоуны до него не дойдут); живые коды подключения переживают права создателя (`claim` не перепроверяет создателя, до 10 минут); откат системных часов сразу после замены кода оживляет замененный код (в `expires_at` можно писать эпоху вместо «сейчас», миграция не нужна); проверка «Windows: журнал службы после сессии оператора, бейджа и смены PIN не содержит `pbkdf2$` и соли».
- Решения владельца ждут: уникальность контрагента по ИНН или GLN (сейчас двойной щелчок или повтор запроса после потерянного ответа создаёт дубликат); политика версий протокола после выпуска; нужна ли защита от отката системных часов.

**Проверено**

- На 8f8ffa7 (код итоговой волны и тестов оборванного запроса):
  - `cargo test --workspace` (вне песочницы) — 36 наборов, 335 тестов, без предупреждений; `cargo fmt --check`; `cargo check --workspace --all-targets` без предупреждений;
  - Vitest — 29 файлов, 531 тест, в stderr пусто; `typecheck`, `lint`;
  - `git diff --check` по всему плану (0d3f69b..HEAD) и по рабочему дереву.
- Итоговое ревью проверило исправления своими мутациями: 16 прогонов, из них 15 роняют тест. Оставшийся (отзыв устройства, вернувшийся к последовательной записи) закрыт тестом оборванного запроса (8f8ffa7).

**Не проверено**

- Окно `tauri dev`; Windows и DPAPI.
- Два ПК в настоящей сети: отзыв станции с открытым потоком (станция уходит на повторное подключение примерно за секунду, вторая продолжает синхронизироваться), отзыв устройства, которым пользуется администратор; после плана 1d3 — «Новый код», затем разбор старого кода на другом ПК даёт «код истёк»; линия, назначенная в офисе, и то, что показывает станция.
- Задание `standalone-windows-build` — для CI нужен push.
- После плана 1f: бейдж отключённого оператора отвергается, старый PIN не проходит после синхронизации; офлайн станция отстаёт от хоста, и об этом надо сказать владельцу.
