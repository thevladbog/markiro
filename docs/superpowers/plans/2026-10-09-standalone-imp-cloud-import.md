# План ИМП: перенос из облачного сервера в «Markiro Автоном» — выгрузка по копии базы, импорт на хосте, страница офиса, памятка переключения — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести данные клиента из облачного варианта в новую площадку автонома без повторных SSCC и без новых PIN: инструмент выгрузки читает восстановленную копию облачной базы и пишет один файл переноса с контрольной суммой; хост принимает его одним маршрутом (`POST /v1/office/import`: только администратор, одна транзакция, пробный прогон, повтор того же файла, отказ на непустой площадке); офис показывает файл, его замечания и таблицу SSCC и переносит его после успешной проверки; памятка описывает переключение и откат.

**Architecture:**

- `tools/standalone-export/` (Node 24, только встроенные модули и `psql`): `export.sql` читает одного арендатора одной транзакцией REPEATABLE READ READ ONLY; `transform.mjs` строит файл (`sscc.mjs` — стартовые номера SSCC и окно отката, `phc.mjs` — хеши PIN и бейджей в формате хоста, `canonical.mjs` — контрольная сумма); `cli.mjs` запускает `psql` по переменным libpq, пишет файл только владельцу и печатает сводку без секретов. Тесты — `node --test` (корневой `pnpm test:standalone-export`), тест SQL — по базе с миграциями облака (CI `verify-api-tests`).
- `apps/standalone/proto/fixtures/cloud-export-file.json` — эталонный выход инструмента по `tools/standalone-export/test/fixtures/raw-cloud.json`; его читают тесты инструмента, `proto`, хоста и вебвью, поэтому формат не может разойтись.
- `proto/src/cloud_import.rs` — запрос и ответ маршрута; `host/src/cloud_import.rs` — проверки строк файла без базы; `host/src/routes/cloud_import.rs` — маршрут; запись журнала `import.cloud` — запись о переносе, по ней отвечает повтор. Миграций нет.
- Вебвью: `src/host/cloud-import.ts` (схемы Zod файла и ответа, канонический JSON, проверка контрольной суммы, построитель запроса), `HostApi.importFromCloud`; страница «Сервис → Перенос из облака» (`src/office/import/`).
- `docs/runbooks/standalone-cloud-cutover.md` — пробный прогон, граница смен, выгрузка, перевод облачных счётчиков, перенос, откат.

**Tech Stack:** Node 24 (`node:test`, `node:crypto`, `node:child_process`), `psql` 16+, PostgreSQL 17 (облако); Rust — axum 0.8.9 (`DefaultBodyLimit` на маршруте), sqlx 0.8.6, serde, serde_json (без `preserve_order`), time 0.3.55, uuid 1; TypeScript — React 19, Zod 4.4.3, react-query 5, Vitest 4, `@markiro/ui` (`FileDropZone`, `Table`, `DefinitionGrid`).

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — раздел 8 целиком (8.1–8.10), строка 14 таблицы 4.1, вопросы П4–П8 раздела 14, раздел 15 (что нельзя проверить без данных клиента), раздел 16 (риски).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — мастер, ревизии и лента, ошибки, роли, журнал действий.
- `apps/standalone/AGENTS.md` — «Audit», «Writes», «Change feed», «Operators and badges», «Catalog and label templates», «Protocol», «Logs», «Verification»; образец плана — `docs/superpowers/plans/2026-10-08-standalone-2a1-host-shifts.md`.
- Облако, с которого сняты правила: `packages/db/src/schema/{platform,pickup,org-profile,labels,auth}.ts`, `apps/api/src/lib/{pin-hash,badge-salt}.ts`, `apps/api/src/modules/operators/operators.service.ts` (`buildRoster`, `activeBadgeHashes`), `apps/api/src/modules/sscc/sscc.service.ts` (`seedFloor`, `findSeedBlocker`, `seedCounter`, `deriveIssuerPrefix`).

## Допущения по вопросам владельцу

Владелец не ответил на вопросы раздела 14 спецификации пилота. План принимает рекомендованный ответ каждого вопроса, который касается переноса; ниже — что принято и что поправить при другом ответе.

- **П5 — чем делать файл: вариант А.** Скрипт `tools/standalone-export` по восстановленной копии базы (задачи 1–3); облачный API и кабинет не меняются и не выкладываются. Вариант Б (маршрут облачного API) использовал бы тот же `transform.mjs` поверх запросов Drizzle — отдельный план и выкладка облака. Вариант В — задачи 1–3 и 7–8 не нужны, хост-маршрут остаётся полезен для пробного прогона.
- **П6 — окно SSCC для отката: вариант А.** 1 000 000 коробов и 100 000 паллет (`BOX_WINDOW`, `PALLET_WINDOW` в `sscc.mjs`). Другие числа — правка двух констант и строк `cloudReseedTo` в эталонном файле. Вариант В («без окна»): колонку «облако перевести на» памятка велит не применять, откат — ручной перевод облачного счётчика выше счётчика автонома (памятка, шаг 6).
- **П7 — хеши кодов за 90 дней: нет.** Рекомендация условна («да, если клиент перерабатывает возвраты»), сведений нет; формат 1 файла их не несёт. Если ответ «да» — `formatVersion` 2 с разделом `historicalCodeHashes`, таблица `legacy_code_owners` и проверка в приёме `scan` (план ПЛ-Х), +2 задачи.
- **П8 — когда переключаться: перед выходными, жёстко на границе смен, облако только для чтения истории, окно отката неделя.** Это памятка (задача 9); код от ответа не зависит.
- **П4 — SSCC под префиксом контрагента: нет.** Счётчики префиксов контрагентов переносятся как «полы» (вперёд можно, назад нельзя), а смены с таким выпуском дают замечание `counterparty_sscc_used`: выпускать под префиксом контрагента автоном не умеет. Если ответ «да» — новый план (около 6 задач, раздел 14 спецификации).
- **П1 — хост на станции (вариант Б), П10 — рекомендации 2a приняты.** Перенос от них не зависит: мастер и перенос выполняются на ПК хоста.

## Шаги владельца

Новых зависимостей нет: `Cargo.toml`, `Cargo.lock`, `package.json` (кроме строки скрипта) и `pnpm-lock.yaml` не меняются, задачи «шаг владельца» нет. Владелец даёт для испытаний и переключения (их нет в автоматических проверках):

1. Проверенную резервную копию прод-базы облака и временный экземпляр Postgres, развёрнутый из неё (новый кластер управляемого Postgres из копии); переменные libpq (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` или `~/.pgpass`, `PGDATABASE`, `PGSSLMODE`) для запуска выгрузки вне песочницы.
2. `tenantId` клиента (`organization.id`).
3. Объём данных клиента (товары, шаблоны, операторы, бейджи, смены в сутки) и ответы П4/П7 по факту: есть ли у клиента смены с `sscc_issuer_counterparty_id` и перерабатывает ли он возвраты.
4. Доступ администратора к кабинету облака для перевода счётчиков SSCC (памятка, шаг 4).
5. ПК с Windows для пробного переноса (памятка, шаг 1) — перенос в офисе на WebView2 автоматически не проверяется.

## Global Constraints

**Решения спецификации, обязательные для ИМП**

1. Файл переноса: `markiro-cloud-export-<ИНН>-<дата>.json`, `formatVersion` 1, источник (`tenantId`), организация, линии, контрагенты, товары, шаблоны и их умолчания, операторы с хешами PIN, бейджи (только хеши под солью арендатора и подписи), соль бейджей, счётчики SSCC и номеров смен; контрольная сумма. Ходит на флешке, удаляется после переноса, в журналы не попадает (§8.7).
2. Хеши PIN переносятся байт в байт (`pbkdf2$sha256$<n>$<соль>$<дайджест>`, формат `secrets::parse_phc`); соль арендатора становится солью площадки (§8.3, вариант 1); открытые коды бейджей в файл не попадают; бейдж без хеша или со старой солью хешируется заново из кода той же функцией, что в облаке (`hashBadgeWithSalt`).
3. Стартовый номер SSCC — самый большой выданный облаком номер плюс один, округлённый вверх до 10 000, отдельно для расширений 0 и 1 и по каждому префиксу; облачный счётчик сразу после выгрузки переводится вперёд за окно автонома (§8.4).
4. Номера смен продолжают облачную нумерацию (§8.5).
5. Переключение только при чистом облаке: нет активной смены, каждая станция с живым блоком была на связи после последнего закрытия смены (`findSeedBlocker`, §8.6).
6. Импорт: только администратор; только площадка без товаров, операторов и прочих данных, кроме созданных мастером; одна транзакция — отказ ничего не создаёт; облачные UUID сохраняются; каждая строка проверяется правилами `validate.rs`; одна строка журнала `import.cloud`; предел тела маршрута 32 МиБ; станция получает всё обычной лентой (§8.7).
7. История смен, коды, короба и паллеты не переносятся; открытые смены закрываются и выгружаются в облаке до переключения (§8.6).
8. Теряются: цена, код ЕГАИС, внешний код, фото и контрагент по умолчанию товара; заметки контрагентов; сотрудники без доступа к станции (§8.2).

**Решения планировщика** (уточнения и отступления от спецификации; задача 9 записывает их в `AGENTS.md`)

- `POST /v1/bootstrap` не меняется, шага мастера нет. Маршрут импорта сам заменяет соль площадки (операторов и бейджей на площадке ещё нет — ничего не ломается, запись `site` уходит станциям) и поднимает счётчики только вперёд. Поэтому импорт работает на любой площадке сразу после мастера и после неудачной попытки, а мастер не трогается (его меняют другие потоки). Реквизиты для мастера берутся из сводки выгрузки; GLN обязан совпасть (`conflict` `org_gln`), профиль организации импорт не переписывает.
- Повтор и запись о переносе — без миграции: ключ повтора — `importId` (UUID, который офис делает один раз на прочитанный файл), запись — строка журнала `import.cloud` с итогом. Тот же `importId` получает сохранённый итог (`repeated: true`) без записи, ревизии и строки журнала; другой после переноса — `conflict` `already_imported`. Миграция не нужна, поэтому номер миграции не спорит с `0010` плана 2a2 и миграциями ПЛ-Х, О-Х, РК, которые идут параллельно.
- Площадка «непуста», если есть смена, блок SSCC, умолчание категории, товар, свой шаблон (`stock = 0`), оператор или контрагент (`conflict` `site_not_empty` с `details.entity`, именно в этом порядке: строка, которой нужна другая, идёт раньше). Линии мастера и его типовые шаблоны допустимы: линия файла с именем активной линии площадки не создаётся (`linesPresent`), остальные создаются с облачным UUID.
- Счётчики номеров смен переносятся за все месяцы, в которых облако выдало номер (а не только текущий и следующий): дата производства «задним числом» тоже продолжает облачную нумерацию.
- Значение товара сверх пределов хоста (вместимость, срок годности) очищается с замечанием — товар остаётся черновиком, его не нужно заводить заново; GTIN не из 14 цифр и пустое имя — строка не переносится.
- Самый большой выданный номер — максимум из `sscc_counters.next_serial − 1`, концов всех блоков (отозванных тоже) и номеров SSCC коробов и паллет арендатора под его префиксами: короба, напечатанные до блоков, и перезасев ниже них тоже учтены.
- Контрольная сумма покрывает весь файл, кроме поля `checksum` (а не только `payload`): SHA-256 канонического JSON (ключи по порядку JavaScript, без пробелов). Признак `rehearsal` (`--rehearsal`) делает пробный файл из нечистого облака для §8.8; офис помечает его.
- Хост отклоняет весь файл при любой непринятой строке (`validation_failed` с путём `payload.products.2.gtin14`): инструмент уже привёл данные к правилам, поэтому такой отказ — порча файла или ошибка, а не данные.
- Умолчания организации (короб, паллета) становятся облачными, если файл их называет; иначе остаются типовые мастера. Умолчания дубликата в облаке нет.
- Переносятся все действующие бейджи перенесённых операторов (облачная станция брала только последний бейдж сотрудника). Код с пробелами по краям хешируется обрезанным — так его хеширует станция автонома; код не из печатных ASCII не переносится.
- Протокол не меняется (`PROTOCOL_VERSION` 2): маршрут офисный и новый, сущностей ленты не добавляется, `SYNC_SCHEMA_VERSION` прежний.
- Тест `export.sql` запускается только с `STANDALONE_EXPORT_TEST_DATABASE_URL` (сам сеет и удаляет двух арендаторов с фиксированными id): в CI его задаёт `verify-api-tests` после миграций облака, локально — одноразовый контейнер.

**Журнал действий** (словарь `audit::actions`)

| Действие       | Исполнитель                  | `target_type`/`target_id` | `details`                                                                         |
| -------------- | ---------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `import.cloud` | офисный пользователь (админ) | `site`/`1`                | `{ importId, exportedAt, rehearsal, sourceTenantId, summary }` — без хешей и соли |

Пробный прогон, повтор того же `importId` и любой отказ строки журнала не пишут.

**Код и процесс**

- Правила записи из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision`, коммит через `commit_with_revision`, пул не трогать при открытой транзакции, повтор — без записи, ревизии и строки журнала.
- Секреты (хеши PIN и бейджей, соль, коды бейджей) — никогда в журнале процесса, в строке журнала действий, в выводе инструмента, в замечаниях файла и в сообщениях об ошибках (`JSON.parse` цитирует текст вокруг ошибки — инструмент его не показывает).
- Не меняются: `apps/station`, `packages/*`, `apps/api`, миграции хоста и оболочки, `src-tauri`, мастер (`src/wizard`), `Cargo.toml`, `Cargo.lock`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, и встречается в файле один раз; правки одного файла идут сверху вниз (план применён к копии репозитория шаг за шагом). Шаг тестов применяется раньше шага реализации.
- «Создать» — новый файл, ровно как в блоке. `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, не часть файла. Блоки уже отформатированы `cargo fmt` и prettier.
- Русский текст — буквами, не `\uXXXX`.

**Мутации**

- Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (для задач с Rust); `node_modules/.bin/prettier --check` на изменённые JS, TS, JSON, YAML и MD; `git diff --check`.

**Cargo, pnpm, Node, Postgres и git**

- Cargo — с `--offline --locked`. Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind`: `cloud_import_logs` и весь `cargo test -p markiro-host` — вне песочницы; `--test cloud_import`, `--test cloud_import_rules` и `-p markiro-proto` — в ней. Если Xcode требует принять лицензию (`You have not agreed to the Xcode license agreements`), команды `git` и `cargo` запускаются с `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`, из корня, без `cd`; в свежем рабочем дереве сначала `pnpm --config.verifyDepsBeforeRun=false install --frozen-lockfile --prefer-offline --filter '@markiro/standalone...'` (сеть: registry.npmjs.org) и `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- Тесты инструмента — `node --test` из корня; тест SQL нужен Postgres с миграциями облака. Одноразовый (вне песочницы; образ `postgres:17-alpine` должен быть в локальном кэше, иначе его тянет владелец):

  ```sh
  docker run -d --name markiro-imp-pg -e POSTGRES_USER=markiro -e POSTGRES_PASSWORD=markiro -e POSTGRES_DB=markiro -p 127.0.0.1:55611:5432 postgres:17-alpine
  pnpm --config.verifyDepsBeforeRun=false install --frozen-lockfile --prefer-offline --filter '@markiro/db...'
  DATABASE_URL=postgres://markiro:markiro@127.0.0.1:55611/markiro pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db db:migrate
  ```

  После задачи 3: `docker rm -f markiro-imp-pg`. Никогда не направлять тест на общую или боевую базу.

- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Если вывод выглядит урезанным (локальная обёртка `rtk`), запускайте `rtk proxy <команда>`.

**Счёт тестов**

- До плана: `cargo test -p markiro-host -p markiro-proto` — 34 итоговые строки `test result`, 410 тестов; Vitest — 67 файлов, 1744 теста; `node --test tools/ci/test/*.test.mjs` — 47 (вне песочницы: два теста работают с git во временных каталогах). После: cargo — 38 строк `test result`, 434 теста (хост +20, `proto` +4); Vitest — 69 файлов, 1760 тестов; инструмент — 28 тестов (без базы 27 и 1 пропущен); `tools/ci` — 48.

## Файлы

```
tools/standalone-export/sscc.mjs, test/sscc.test.mjs                                    задача 1
tools/standalone-export/{phc,canonical,transform}.mjs, test/transform.test.mjs           задача 2
tools/standalone-export/test/fixtures/raw-cloud.json                                     задача 2
apps/standalone/proto/fixtures/cloud-export-file.json                                    задача 2
tools/standalone-export/{export.sql,cli.mjs}, test/{cli,export-sql}.test.mjs             задача 3
tools/standalone-export/test/fixtures/{seed-cloud,cleanup-cloud}.sql                     задача 3
package.json, .github/workflows/ci.yml, tools/ci/affected.mjs, tools/ci/test/affected.test.mjs   задача 3
apps/standalone/proto/src/{cloud_import.rs,lib.rs}, proto/tests/cloud_import.rs           задача 4
apps/standalone/proto/fixtures/cloud-import-summary.json                                 задача 4
apps/standalone/host/src/{cloud_import.rs,lib.rs,validate.rs}                             задача 5
apps/standalone/host/tests/{cloud_import_rules.rs,support/app.rs}                         задача 5
apps/standalone/host/src/routes/{cloud_import.rs,mod.rs}, host/src/{audit.rs,server.rs}   задача 6
apps/standalone/host/tests/{cloud_import.rs,cloud_import_logs.rs}                         задача 6
apps/standalone/src/host/{cloud-import.ts,api.ts}, test/cloud-import.test.ts, test/support/office.tsx   задача 7
apps/standalone/src/office/import/{import-notes.ts,CloudImportPage.tsx}                   задача 8
apps/standalone/src/office/{nav.ts,routes.tsx}, src/i18n/ru.json, test/cloud-import-page.test.tsx   задача 8
docs/runbooks/standalone-cloud-cutover.md, apps/standalone/AGENTS.md                      задача 9
```

Порядок: сначала инструмент (задачи 1–3) — он рождает эталонный файл, который читают все остальные; потом типы `proto` (4), проверки хоста без базы (5), маршрут (6), вебвью: чтение файла и вызов (7), страница (8); памятка и документы — последней (9). Задачи 4–6 не зависят от планов цеха (2a5–2a8) и от 2a2: маршрут трогает только таблицы этапа 1 и `0009`. Общие с другими потоками файлы получают только добавления: `proto/src/lib.rs`, `host/src/{lib,audit,server,validate}.rs`, `routes/mod.rs`, `tests/support/app.rs`, `src/host/api.ts`, `test/support/office.tsx`, `src/office/{nav,routes}`, `src/i18n/ru.json`, `AGENTS.md`, `package.json`, `ci.yml`, `affected.mjs`.

---

### Task 1: Инструмент выгрузки — стартовые номера SSCC, окно отката, номера смен (`tools/standalone-export/sscc.mjs`)

Самая дорогая ошибка переноса — повторный SSCC (§8.4). Арифметика вынесена в чистый модуль без базы, чтобы каждую границу закрепил свой тест: «счётчик на первом номере расширения ничего не выдал», «номер уже на кратном 10 000 остаётся», «окно, которое выходит за ёмкость префикса, — `null`». Самый большой выданный номер — максимум из `счётчик − 1`, конца любого блока и номера на коробе или паллете: перезасев в облаке опускает счётчик ниже отозванного блока (`seedCounter`), а короба до блоков блоков не имеют.

**Files:**

- Create: `tools/standalone-export/sscc.mjs`
- Test: `tools/standalone-export/test/sscc.test.mjs` (Create)

**Interfaces:**

- Consumes: ничего.
- Produces (ES-модуль `tools/standalone-export/sscc.mjs`):
  - `SERIAL_CAPACITY = 10_000_000`, `START_STEP = 10_000`, `BOX_WINDOW = 1_000_000`, `PALLET_WINDOW = 100_000`;
  - `firstSerial(extension: 0|1): number`;
  - `issuedMax({ extension, counterNext, blockMax, printedMax }): number | null`;
  - `standaloneStart(extension, issued: number | null): number`;
  - `windowOf(extension, windows?: { box, pallet }): number`;
  - `cloudReseedTo(start, extension, windows?): number | null`;
  - `planSsccCounters({ counters, blocks, printed }, owners: (prefix) => Owner, windows?): CutoverCounter[]`, где `CutoverCounter = { issuerPrefix, extension, owner, issuedMax, printedMax, standaloneStart, cloudReseedTo }`; бросает `Error`, если облако выдало все номера префикса;
  - `planShiftNumberCounters(counters: { monthKey, lastSeq }[]): { monthKey, lastSeq }[]`.

- [ ] **Step 1: Тест (падающий)**

Создать `tools/standalone-export/test/sscc.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOX_WINDOW,
  PALLET_WINDOW,
  SERIAL_CAPACITY,
  cloudReseedTo,
  firstSerial,
  issuedMax,
  planShiftNumberCounters,
  planSsccCounters,
  standaloneStart,
} from "../sscc.mjs";

const none = { counterNext: null, blockMax: null, printedMax: null };

test("boxes start at serial 1 and pallets at 0", () => {
  assert.equal(firstSerial(0), 1);
  assert.equal(firstSerial(1), 0);
});

test("the highest issued serial is the largest of counter − 1, a block's end and a printed serial", () => {
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 18_500 }), 18_499);
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 18_500, blockMax: 19_999 }), 19_999);
  assert.equal(
    issuedMax({ extension: 0, counterNext: 18_500, blockMax: 19_999, printedMax: 21_003 }),
    21_003,
  );
  assert.equal(issuedMax({ extension: 0, ...none, blockMax: 7 }), 7);
  assert.equal(issuedMax({ extension: 0, ...none, printedMax: 3 }), 3);
});

test("a counter at its extension's first serial handed out nothing", () => {
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 1 }), null);
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 2 }), 1);
  assert.equal(issuedMax({ extension: 1, ...none, counterNext: 0 }), null);
  assert.equal(issuedMax({ extension: 1, ...none, counterNext: 1 }), 0);
  assert.equal(issuedMax({ extension: 0, ...none }), null);
});

test("the start is one above the issued serial, rounded up to the next 10 000", () => {
  assert.equal(standaloneStart(0, null), 1);
  assert.equal(standaloneStart(1, null), 0);
  assert.equal(standaloneStart(1, 0), 10_000);
  assert.equal(standaloneStart(0, 9_998), 10_000);
  assert.equal(standaloneStart(0, 9_999), 10_000);
  assert.equal(standaloneStart(0, 10_000), 20_000);
  assert.equal(standaloneStart(0, 21_003), 30_000);
  assert.equal(standaloneStart(0, 9_989_999), 9_990_000);
});

test("the cloud moves past the window, or nowhere when the window leaves the prefix", () => {
  assert.equal(cloudReseedTo(30_000, 0), 30_000 + BOX_WINDOW);
  assert.equal(cloudReseedTo(10_000, 1), 10_000 + PALLET_WINDOW);
  assert.equal(cloudReseedTo(SERIAL_CAPACITY - BOX_WINDOW - 1, 0), SERIAL_CAPACITY - 1);
  assert.equal(cloudReseedTo(SERIAL_CAPACITY - BOX_WINDOW, 0), null);
  assert.equal(cloudReseedTo(30_000, 0, { box: 5_000, pallet: 50 }), 35_000);
  assert.equal(cloudReseedTo(30_000, 1, { box: 5_000, pallet: 50 }), 30_050);
});

test("every prefix and extension of the counters, blocks and printed codes gets a row", () => {
  const owners = (prefix) =>
    prefix === "460068200" ? { kind: "organization" } : { kind: "unknown" };
  const rows = planSsccCounters(
    {
      counters: [
        { issuerPrefix: "460068200", extension: 1, nextSerial: 301 },
        { issuerPrefix: "460068200", extension: 0, nextSerial: 18_500 },
      ],
      blocks: [
        {
          issuerPrefix: "460068200",
          extension: 0,
          maxToSerial: 19_999,
          maxConsumedThrough: 18_750,
        },
        { issuerPrefix: "460068200", extension: 1, maxToSerial: 400, maxConsumedThrough: 250 },
      ],
      printed: [
        { issuerPrefix: "460068200", extension: 0, maxSerial: 21_003 },
        { issuerPrefix: "460000001", extension: 0, maxSerial: 5 },
      ],
    },
    owners,
  );
  assert.deepEqual(rows, [
    {
      issuerPrefix: "460000001",
      extension: 0,
      owner: { kind: "unknown" },
      issuedMax: 5,
      printedMax: 5,
      standaloneStart: 10_000,
      cloudReseedTo: 1_010_000,
    },
    {
      issuerPrefix: "460068200",
      extension: 0,
      owner: { kind: "organization" },
      issuedMax: 21_003,
      printedMax: 21_003,
      standaloneStart: 30_000,
      cloudReseedTo: 1_030_000,
    },
    {
      issuerPrefix: "460068200",
      extension: 1,
      owner: { kind: "organization" },
      issuedMax: 400,
      printedMax: 250,
      standaloneStart: 10_000,
      cloudReseedTo: 110_000,
    },
  ]);
});

test("a prefix the cloud used up stops the export", () => {
  assert.throws(
    () =>
      planSsccCounters(
        {
          counters: [{ issuerPrefix: "460068200", extension: 0, nextSerial: SERIAL_CAPACITY }],
          blocks: [],
          printed: [],
        },
        () => ({ kind: "organization" }),
      ),
    /every serial of prefix 460068200, extension 0/u,
  );
});

test("shift-number counters keep every month that drew a number, by month key", () => {
  assert.deepEqual(
    planShiftNumberCounters([
      { monthKey: "OCT26", lastSeq: 7 },
      { monthKey: "NOV26", lastSeq: 0 },
      { monthKey: "SEP26", lastSeq: 41 },
      { monthKey: "Sep26", lastSeq: 3 },
      { monthKey: "SEP2026", lastSeq: 3 },
    ]),
    [
      { monthKey: "OCT26", lastSeq: 7 },
      { monthKey: "SEP26", lastSeq: 41 },
    ],
  );
  assert.deepEqual(planShiftNumberCounters([{ monthKey: "JAN27", lastSeq: 1 }]), [
    { monthKey: "JAN27", lastSeq: 1 },
  ]);
});
```

- [ ] **Step 2: Запуск — падает**

Run: `node --test tools/standalone-export/test/sscc.test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`, `Cannot find module '…/tools/standalone-export/sscc.mjs'`.

- [ ] **Step 3: Реализация**

Создать `tools/standalone-export/sscc.mjs`:

<!-- prettier-ignore -->
```js
/**
 * SSCC and shift-number arithmetic of the cloud → standalone move (pilot spec
 * §8.4, §8.5). Pure: the caller passes what `export.sql` read.
 *
 * A serial the cloud ever handed out under a prefix and an extension must
 * never be printed again by the standalone. The cloud's `sscc_counters`
 * marks where its NEXT BLOCK is cut, and a reseed may have moved it below a
 * block it revoked or below boxes printed before blocks existed, so the
 * highest serial ever handed out is the largest of three numbers: the
 * counter minus one, the highest end of any block (revoked ones included),
 * and the highest serial on a box or a pallet of the tenant. The standalone
 * starts one above it, rounded up to the next 10 000, so its first SSCC is
 * told apart at a glance and the gap absorbs anything the cloud printed but
 * never reported. The cloud's counter then moves past a window the
 * standalone fills, so a rollback (§8.10) never prints a serial twice.
 */

/** Serials after a 9-digit issuer prefix: 16 − 9 = 7 digits. */
export const SERIAL_CAPACITY = 10_000_000;
/** The standalone's first serial is a multiple of this. */
export const START_STEP = 10_000;
/** Owner question П6, recommended answer A: the rollback windows. */
export const BOX_WINDOW = 1_000_000;
export const PALLET_WINDOW = 100_000;

/** The first serial of an extension digit: boxes start at 1, pallets at 0. */
export function firstSerial(extension) {
  return extension === 0 ? 1 : 0;
}

/**
 * The highest serial the cloud ever handed out, or `null` when it never
 * handed one out. `counterNext` is `sscc_counters.next_serial` (or `null`
 * without a row), `blockMax` the largest `sscc_blocks.to_serial`, `printedMax`
 * the largest serial on a box or a pallet.
 */
export function issuedMax({ extension, counterNext, blockMax, printedMax }) {
  const candidates = [];
  if (counterNext !== null && counterNext - 1 >= firstSerial(extension)) {
    candidates.push(counterNext - 1);
  }
  if (blockMax !== null) candidates.push(blockMax);
  if (printedMax !== null) candidates.push(printedMax);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * Where the standalone's counter starts: the extension's first serial when
 * the cloud handed out none, else one above the highest, rounded up to the
 * next multiple of `START_STEP` (a serial already on such a multiple stays).
 */
export function standaloneStart(extension, issued) {
  if (issued === null) return firstSerial(extension);
  return Math.ceil((issued + 1) / START_STEP) * START_STEP;
}

/** The rollback window of an extension. */
export function windowOf(extension, windows = { box: BOX_WINDOW, pallet: PALLET_WINDOW }) {
  return extension === 0 ? windows.box : windows.pallet;
}

/**
 * Where the cloud's counter moves after the export: past the standalone's
 * window. `null` when that would leave the prefix's serials: the window does
 * not fit, and the owner decides (pilot spec §8.10, «без окна»).
 */
export function cloudReseedTo(start, extension, windows) {
  const target = start + windowOf(extension, windows);
  return target < SERIAL_CAPACITY ? target : null;
}

/**
 * One row per (prefix, extension) the tenant has a counter, a block or a
 * printed SSCC of. `counters`, `blocks` and `printed` are `export.sql`'s
 * arrays; `owners` names whose prefix it is. Rows come by prefix, then
 * extension. Throws when the cloud already used the whole prefix: the
 * standalone could never issue under it.
 */
export function planSsccCounters({ counters, blocks, printed }, owners, windows) {
  const rows = new Map();
  const row = (issuerPrefix, extension) => {
    const key = `${issuerPrefix}:${extension}`;
    if (!rows.has(key)) {
      rows.set(key, {
        issuerPrefix,
        extension,
        counterNext: null,
        blockMax: null,
        consumedMax: null,
        printedMax: null,
      });
    }
    return rows.get(key);
  };
  for (const counter of counters) {
    row(counter.issuerPrefix, counter.extension).counterNext = counter.nextSerial;
  }
  for (const block of blocks) {
    const each = row(block.issuerPrefix, block.extension);
    each.blockMax = block.maxToSerial;
    each.consumedMax = block.maxConsumedThrough;
  }
  for (const each of printed) {
    row(each.issuerPrefix, each.extension).printedMax = each.maxSerial;
  }
  return [...rows.values()]
    .sort((a, b) =>
      a.issuerPrefix === b.issuerPrefix
        ? a.extension - b.extension
        : a.issuerPrefix < b.issuerPrefix
          ? -1
          : 1,
    )
    .map((each) => {
      const issued = issuedMax(each);
      const start = standaloneStart(each.extension, issued);
      if (start >= SERIAL_CAPACITY) {
        throw new Error(
          `the cloud used every serial of prefix ${each.issuerPrefix}, extension ${each.extension}`,
        );
      }
      const printedCandidates = [each.consumedMax, each.printedMax].filter(
        (value) => value !== null,
      );
      return {
        issuerPrefix: each.issuerPrefix,
        extension: each.extension,
        owner: owners(each.issuerPrefix),
        issuedMax: issued,
        printedMax: printedCandidates.length === 0 ? null : Math.max(...printedCandidates),
        standaloneStart: start,
        cloudReseedTo: cloudReseedTo(start, each.extension, windows),
      };
    });
}

const MONTH_KEY = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}$/u;

/**
 * The cloud's shift-number counters the standalone continues (§8.5): every
 * month the cloud drew a number in, so a backdated production date continues
 * the cloud's numbering too. A counter that never drew a number (0) or a key
 * that is no `MONYY` is left out. By month key.
 */
export function planShiftNumberCounters(counters) {
  return counters
    .filter((each) => MONTH_KEY.test(each.monthKey) && Number.isInteger(each.lastSeq))
    .filter((each) => each.lastSeq > 0)
    .map((each) => ({ monthKey: each.monthKey, lastSeq: each.lastSeq }))
    .sort((a, b) => (a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : 0));
}
```

- [ ] **Step 4: Запуск — проходит**

Run: `node --test tools/standalone-export/test/sscc.test.mjs`
Expected: `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Мутации (каждую — откатить, см. «Мутации»)**

1. В `standaloneStart` `Math.ceil` → `Math.floor` — FAIL `the start is one above the issued serial, rounded up to the next 10 000` (и `every prefix and extension …`).
2. В `issuedMax` `counterNext - 1 >= firstSerial(extension)` → `counterNext - 1 > firstSerial(extension)` — FAIL `a counter at its extension's first serial handed out nothing`.
3. В `cloudReseedTo` `target < SERIAL_CAPACITY` → `target <= SERIAL_CAPACITY` — FAIL `the cloud moves past the window, or nowhere when the window leaves the prefix`.
4. В `issuedMax` удалить строку `if (printedMax !== null) candidates.push(printedMax);` — FAIL `the highest issued serial is …` и `every prefix and extension …`.

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check tools/standalone-export
git diff --check
git add tools/standalone-export/sscc.mjs tools/standalone-export/test/sscc.test.mjs
git commit -m "feat(standalone): cloud export: SSCC starts, the rollback window and shift numbers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Инструмент выгрузки — файл переноса, замечания, контрольная сумма (`transform.mjs`, эталонный файл)

`transform.mjs` превращает то, что прочитал `export.sql` (задача 3; сейчас — фикстура `raw-cloud.json`), в файл переноса. `payload` — ровно запрос хоста: всё, что хост не примет, исправлено или выброшено здесь и названо в `notes` (коды замечаний читает страница задачи 8). Свободный текст — правило хоста: управляющие символы (`\p{Cc}`, это `char::is_control`) становятся пробелом, края обрезаются, длина считается в кодовых точках. PIN-хеш проверяется правилом `parse_phc` хоста (ведущий ноль в числе итераций — отказ). Бейдж: текущий хеш под солью арендатора остаётся; без хеша, со старой солью или с пробелами по краям кода — хешируется заново из обрезанного кода; кода в файле нет нигде. Эталонный файл `cloud-export-file.json` — выход по фикстуре; тест сравнивает их целиком, а тесты задач 4–8 читают его.

Фикстура `raw-cloud.json` — дословный вывод `export.sql` по засеву задачи 3 (тест задачи 3 сверяет их целиком). В ней собраны края: повтор имени линии без учёта регистра, контрагент с GLN из 5 цифр и с ИНН из 5 цифр, шаблон-массив вместо объекта, выключенный шаблон в умолчании категории, товар с GTIN из 13 цифр (`char(14)` облака отдаёт его без хвостового пробела), с вместимостью паллеты 100 000 и сроком 5000 дней, архивный товар с GTIN действующего, операторы с номером «12», с PIN-хешем `0100000` итераций, с табуляцией в имени, выключенный и в архиве, бейджи с текущим хешем, без хеша, со старой солью и пробелами, с кириллицей и чужого (выброшенного) оператора, счётчики, блоки (отозванный выше счётчика) и напечатанный короб выше всех блоков.

**Files:**

- Create: `tools/standalone-export/phc.mjs`, `tools/standalone-export/canonical.mjs`, `tools/standalone-export/transform.mjs`
- Create: `tools/standalone-export/test/fixtures/raw-cloud.json`, `apps/standalone/proto/fixtures/cloud-export-file.json`
- Test: `tools/standalone-export/test/transform.test.mjs` (Create)

**Interfaces:**

- Consumes: `planSsccCounters`, `planShiftNumberCounters`, `BOX_WINDOW`, `PALLET_WINDOW` (задача 1).
- Produces:
  - `phc.mjs`: `BADGE_ITERATIONS = 100_000`, `decodeCanonical(text, bytes): Buffer | null`, `parsePhc(text): { iterations, salt, digest } | null`, `isBadgePhcUnder(text, salt): boolean`, `hashBadge(code, salt): string`;
  - `canonical.mjs`: `canonicalJson(value): string`, `fileChecksum(file): "sha256:<hex>"` (весь файл без `checksum`);
  - `transform.mjs`: `FILE_FORMAT = "markiro-cloud-export"`, `FILE_FORMAT_VERSION = 1`, `TOOL = "standalone-export/1"`, `class ExportError extends Error { code; blockers? }` (коды `tenant_not_found`, `org_profile_missing`, `org_gln_missing`, `org_name_missing`, `cloud_not_clean`, `sscc_exhausted`), `plainText(text, max)`, `depthOf(value)`, `buildExportFile(raw, { exportedAt, rehearsal?, windows?, randomBytes? }): CloudExportFile`;
  - файл: `{ format, formatVersion, tool, exportedAt, rehearsal, checksum, source: { tenantId, tenantName }, payload, cutover: { boxWindow, palletWindow, ssccCounters: CutoverCounter[] }, notes: { code, … }[] }`; `payload` — поля `CloudImportPayload` задачи 4.

- [ ] **Step 1: Фикстуры и тест (падающий)**

Создать `tools/standalone-export/test/fixtures/raw-cloud.json`:

<!-- prettier-ignore -->
```json
{
  "formatVersion": 1,
  "tenant": {
    "id": "imp-test-atoll",
    "name": "ООО «Атолл»"
  },
  "orgProfile": {
    "gln": "4600682000010",
    "inn": "7701234567",
    "gs1Prefixes": ["4600682", " 4600682 ", "46x"],
    "timeZone": "Europe/Moscow",
    "defaultBoxTemplateId": "0d0d0000-0000-4000-8000-000000000001",
    "defaultPalletTemplateId": "0d0d0000-0000-4000-8000-000000000003"
  },
  "badgeSalt": "bWFya2lyby1iYWRnZS0wMQ==",
  "lines": [
    {
      "id": "0a0a0000-0000-4000-8000-000000000001",
      "name": "Линия 1"
    },
    {
      "id": "0a0a0000-0000-4000-8000-000000000002",
      "name": "Упаковка"
    },
    {
      "id": "0a0a0000-0000-4000-8000-000000000003",
      "name": " линия 1 "
    }
  ],
  "counterparties": [
    {
      "id": "0c0c0000-0000-4000-8000-000000000001",
      "name": "ООО «Берег»",
      "inn": "7812345678",
      "gln": "4601234000017",
      "gs1Prefixes": ["4601234"],
      "hasNotes": true
    },
    {
      "id": "0c0c0000-0000-4000-8000-000000000002",
      "name": "ИП Петров",
      "inn": null,
      "gln": "46012",
      "gs1Prefixes": [],
      "hasNotes": false
    },
    {
      "id": "0c0c0000-0000-4000-8000-000000000003",
      "name": "АО «Дельта»",
      "inn": "12345",
      "gln": "4607000000014",
      "gs1Prefixes": [],
      "hasNotes": false
    }
  ],
  "templates": [
    {
      "id": "0d0d0000-0000-4000-8000-000000000001",
      "name": "Короб 58×40",
      "purpose": "box",
      "enabled": true,
      "chzProductGroupCodes": null,
      "spec": {
        "dpi": 203,
        "widthMm": 58,
        "elements": [],
        "heightMm": 40,
        "language": "zpl"
      }
    },
    {
      "id": "0d0d0000-0000-4000-8000-000000000002",
      "name": "Короб молочный",
      "purpose": "box",
      "enabled": true,
      "chzProductGroupCodes": [8],
      "spec": {
        "dpi": 203,
        "widthMm": 58,
        "elements": [],
        "heightMm": 60,
        "language": "zpl"
      }
    },
    {
      "id": "0d0d0000-0000-4000-8000-000000000003",
      "name": "Паллета 100×150",
      "purpose": "pallet",
      "enabled": true,
      "chzProductGroupCodes": null,
      "spec": {
        "dpi": 203,
        "widthMm": 100,
        "elements": [],
        "heightMm": 150,
        "language": "zpl"
      }
    },
    {
      "id": "0d0d0000-0000-4000-8000-000000000004",
      "name": "Дубликат",
      "purpose": "product_duplicate",
      "enabled": true,
      "chzProductGroupCodes": null,
      "spec": {
        "dpi": 203,
        "widthMm": 58,
        "elements": [],
        "heightMm": 40,
        "language": "zpl"
      }
    },
    {
      "id": "0d0d0000-0000-4000-8000-000000000005",
      "name": "Старый короб",
      "purpose": "box",
      "enabled": false,
      "chzProductGroupCodes": null,
      "spec": {
        "dpi": 300,
        "widthMm": 58,
        "elements": [],
        "heightMm": 40,
        "language": "tspl"
      }
    },
    {
      "id": "0d0d0000-0000-4000-8000-000000000006",
      "name": "Не макет",
      "purpose": "box",
      "enabled": true,
      "chzProductGroupCodes": null,
      "spec": ["not", "a", "layout"]
    }
  ],
  "boxDefaults": [
    {
      "chzProductGroupCode": 8,
      "templateId": "0d0d0000-0000-4000-8000-000000000002"
    },
    {
      "chzProductGroupCode": 13,
      "templateId": "0d0d0000-0000-4000-8000-000000000005"
    }
  ],
  "palletDefaults": [
    {
      "chzProductGroupCode": 8,
      "templateId": "0d0d0000-0000-4000-8000-000000000003"
    }
  ],
  "products": [
    {
      "id": "0e0e0000-0000-4000-8000-000000000001",
      "gtin14": "04600682000013",
      "name": "Молоко 3,2% 0,9 л",
      "printName": "Молоко 3,2%",
      "chzProductGroupCode": 8,
      "boxCapacity": 12,
      "palletBoxCapacity": 40,
      "shelfLifeDays": 10,
      "archived": false,
      "defaultLabelTemplateId": "0d0d0000-0000-4000-8000-000000000002",
      "lost": ["price"]
    },
    {
      "id": "0e0e0000-0000-4000-8000-000000000002",
      "gtin14": "04600682000020",
      "name": "Вода яяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяя",
      "printName": null,
      "chzProductGroupCode": 13,
      "boxCapacity": 6,
      "palletBoxCapacity": 100000,
      "shelfLifeDays": 5000,
      "archived": false,
      "defaultLabelTemplateId": "0d0d0000-0000-4000-8000-000000000003",
      "lost": ["externalRef"]
    },
    {
      "id": "0e0e0000-0000-4000-8000-000000000003",
      "gtin14": "04600682000013",
      "name": "Молоко (старая карточка)",
      "printName": null,
      "chzProductGroupCode": 8,
      "boxCapacity": 12,
      "palletBoxCapacity": 40,
      "shelfLifeDays": null,
      "archived": true,
      "defaultLabelTemplateId": "0d0d0000-0000-4000-8000-000000000004",
      "lost": ["egaisCode"]
    },
    {
      "id": "0e0e0000-0000-4000-8000-000000000004",
      "gtin14": "4600682000037",
      "name": "Кефир",
      "printName": null,
      "chzProductGroupCode": null,
      "boxCapacity": null,
      "palletBoxCapacity": null,
      "shelfLifeDays": null,
      "archived": false,
      "defaultLabelTemplateId": null,
      "lost": []
    }
  ],
  "operators": [
    {
      "id": "0f0f0000-0000-4000-8000-000000000001",
      "login": "0042",
      "pinHash": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
      "credentialActive": true,
      "employeeStatus": "active",
      "fullName": "Анна Кузнецова",
      "role": "Оператор линии"
    },
    {
      "id": "0f0f0000-0000-4000-8000-000000000002",
      "login": "117",
      "pinHash": "pbkdf2$sha256$100000$bWFya2lyby1waW4tdHdvIQ==$QVZc+yU8wJn39tbKU3wt1Q2wIycAv4j5TS8wJZxy3u8=",
      "credentialActive": false,
      "employeeStatus": "active",
      "fullName": "Пётр\tСидоров",
      "role": null
    },
    {
      "id": "0f0f0000-0000-4000-8000-000000000003",
      "login": "12",
      "pinHash": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
      "credentialActive": true,
      "employeeStatus": "active",
      "fullName": "Илья Короткий",
      "role": null
    },
    {
      "id": "0f0f0000-0000-4000-8000-000000000004",
      "login": "205",
      "pinHash": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
      "credentialActive": true,
      "employeeStatus": "archived",
      "fullName": "Ольга Архивная",
      "role": null
    },
    {
      "id": "0f0f0000-0000-4000-8000-000000000005",
      "login": "306",
      "pinHash": "pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
      "credentialActive": true,
      "employeeStatus": "active",
      "fullName": "Сергей Без-Пина",
      "role": null
    }
  ],
  "badges": [
    {
      "id": "0b0b0000-0000-4000-8000-000000000001",
      "operatorId": "0f0f0000-0000-4000-8000-000000000001",
      "badgeCode": "MRK-000742",
      "badgeHash": "pbkdf2$sha256$100000$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo=",
      "label": "Пропуск 1"
    },
    {
      "id": "0b0b0000-0000-4000-8000-000000000002",
      "operatorId": "0f0f0000-0000-4000-8000-000000000001",
      "badgeCode": "MRK-000743",
      "badgeHash": null,
      "label": null
    },
    {
      "id": "0b0b0000-0000-4000-8000-000000000003",
      "operatorId": "0f0f0000-0000-4000-8000-000000000002",
      "badgeCode": " MRK-000744 ",
      "badgeHash": "pbkdf2$sha256$100000$bGVnYWN5LXJvdy1zYWx0IQ==$vULnmFLrlEL53UOHeKzL62/qUqLZKBBI/X0BXSWxx5E=",
      "label": "Запасной\nбейдж"
    },
    {
      "id": "0b0b0000-0000-4000-8000-000000000004",
      "operatorId": "0f0f0000-0000-4000-8000-000000000001",
      "badgeCode": "МРК-1",
      "badgeHash": null,
      "label": null
    },
    {
      "id": "0b0b0000-0000-4000-8000-000000000005",
      "operatorId": "0f0f0000-0000-4000-8000-000000000003",
      "badgeCode": "MRK-000746",
      "badgeHash": null,
      "label": null
    }
  ],
  "nonOperatorBadges": 2,
  "ssccCounters": [
    {
      "issuerPrefix": "460068200",
      "extension": 0,
      "nextSerial": 18500
    },
    {
      "issuerPrefix": "460068200",
      "extension": 1,
      "nextSerial": 301
    },
    {
      "issuerPrefix": "460123400",
      "extension": 0,
      "nextSerial": 1
    }
  ],
  "ssccBlocks": [
    {
      "issuerPrefix": "460068200",
      "extension": 0,
      "maxToSerial": 19999,
      "maxConsumedThrough": 18750
    },
    {
      "issuerPrefix": "460068200",
      "extension": 1,
      "maxToSerial": 400,
      "maxConsumedThrough": 250
    }
  ],
  "ssccPrinted": [
    {
      "issuerPrefix": "460068200",
      "extension": 0,
      "maxSerial": 21003
    },
    {
      "issuerPrefix": "460068200",
      "extension": 1,
      "maxSerial": 250
    }
  ],
  "shiftNumberCounters": [
    {
      "monthKey": "DEC26",
      "lastSeq": 0
    },
    {
      "monthKey": "NOV26",
      "lastSeq": 1
    },
    {
      "monthKey": "OCT26",
      "lastSeq": 7
    },
    {
      "monthKey": "SEP26",
      "lastSeq": 41
    }
  ],
  "activeShifts": [],
  "staleDevices": [],
  "counterpartyIssuedShifts": 1,
  "plannedShifts": 2
}
```

Создать `apps/standalone/proto/fixtures/cloud-export-file.json`:

<!-- prettier-ignore -->
```json
{
  "format": "markiro-cloud-export",
  "formatVersion": 1,
  "tool": "standalone-export/1",
  "exportedAt": "2026-10-09T18:30:00.000Z",
  "rehearsal": false,
  "checksum": "sha256:9716b9df54092b60e007f36bfce2eea504bb7b61a1f08d7e9bf5186be09945c5",
  "source": {
    "tenantId": "imp-test-atoll",
    "tenantName": "ООО «Атолл»"
  },
  "payload": {
    "organization": {
      "name": "ООО «Атолл»",
      "inn": "7701234567",
      "gln": "4600682000010",
      "gs1Prefixes": ["4600682"],
      "timeZone": "Europe/Moscow"
    },
    "badgeSalt": "bWFya2lyby1iYWRnZS0wMQ==",
    "lines": [
      {
        "id": "0a0a0000-0000-4000-8000-000000000001",
        "name": "Линия 1"
      },
      {
        "id": "0a0a0000-0000-4000-8000-000000000002",
        "name": "Упаковка"
      },
      {
        "id": "0a0a0000-0000-4000-8000-000000000003",
        "name": "линия 1 (2)"
      }
    ],
    "counterparties": [
      {
        "id": "0c0c0000-0000-4000-8000-000000000001",
        "name": "ООО «Берег»",
        "inn": "7812345678",
        "gln": "4601234000017",
        "gs1Prefixes": ["4601234"]
      },
      {
        "id": "0c0c0000-0000-4000-8000-000000000003",
        "name": "АО «Дельта»",
        "inn": null,
        "gln": "4607000000014",
        "gs1Prefixes": []
      }
    ],
    "templates": [
      {
        "id": "0d0d0000-0000-4000-8000-000000000001",
        "name": "Короб 58×40",
        "purpose": "box",
        "enabled": true,
        "chzProductGroupCodes": null,
        "spec": {
          "dpi": 203,
          "widthMm": 58,
          "elements": [],
          "heightMm": 40,
          "language": "zpl"
        }
      },
      {
        "id": "0d0d0000-0000-4000-8000-000000000002",
        "name": "Короб молочный",
        "purpose": "box",
        "enabled": true,
        "chzProductGroupCodes": [8],
        "spec": {
          "dpi": 203,
          "widthMm": 58,
          "elements": [],
          "heightMm": 60,
          "language": "zpl"
        }
      },
      {
        "id": "0d0d0000-0000-4000-8000-000000000003",
        "name": "Паллета 100×150",
        "purpose": "pallet",
        "enabled": true,
        "chzProductGroupCodes": null,
        "spec": {
          "dpi": 203,
          "widthMm": 100,
          "elements": [],
          "heightMm": 150,
          "language": "zpl"
        }
      },
      {
        "id": "0d0d0000-0000-4000-8000-000000000004",
        "name": "Дубликат",
        "purpose": "product_duplicate",
        "enabled": true,
        "chzProductGroupCodes": null,
        "spec": {
          "dpi": 203,
          "widthMm": 58,
          "elements": [],
          "heightMm": 40,
          "language": "zpl"
        }
      },
      {
        "id": "0d0d0000-0000-4000-8000-000000000005",
        "name": "Старый короб",
        "purpose": "box",
        "enabled": false,
        "chzProductGroupCodes": null,
        "spec": {
          "dpi": 300,
          "widthMm": 58,
          "elements": [],
          "heightMm": 40,
          "language": "tspl"
        }
      }
    ],
    "templateDefaults": {
      "defaultBoxTemplateId": "0d0d0000-0000-4000-8000-000000000001",
      "defaultPalletTemplateId": "0d0d0000-0000-4000-8000-000000000003",
      "categories": [
        {
          "chzProductGroupCode": 8,
          "purpose": "box",
          "templateId": "0d0d0000-0000-4000-8000-000000000002"
        },
        {
          "chzProductGroupCode": 8,
          "purpose": "pallet",
          "templateId": "0d0d0000-0000-4000-8000-000000000003"
        }
      ]
    },
    "products": [
      {
        "id": "0e0e0000-0000-4000-8000-000000000001",
        "gtin14": "04600682000013",
        "name": "Молоко 3,2% 0,9 л",
        "printName": "Молоко 3,2%",
        "chzProductGroupCode": 8,
        "boxCapacity": 12,
        "palletBoxCapacity": 40,
        "shelfLifeDays": 10,
        "defaultBoxTemplateId": "0d0d0000-0000-4000-8000-000000000002",
        "defaultPalletTemplateId": null,
        "archived": false
      },
      {
        "id": "0e0e0000-0000-4000-8000-000000000002",
        "gtin14": "04600682000020",
        "name": "Вода яяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяяя",
        "printName": null,
        "chzProductGroupCode": 13,
        "boxCapacity": 6,
        "palletBoxCapacity": null,
        "shelfLifeDays": null,
        "defaultBoxTemplateId": null,
        "defaultPalletTemplateId": "0d0d0000-0000-4000-8000-000000000003",
        "archived": false
      },
      {
        "id": "0e0e0000-0000-4000-8000-000000000003",
        "gtin14": "04600682000013",
        "name": "Молоко (старая карточка)",
        "printName": null,
        "chzProductGroupCode": 8,
        "boxCapacity": 12,
        "palletBoxCapacity": 40,
        "shelfLifeDays": null,
        "defaultBoxTemplateId": null,
        "defaultPalletTemplateId": null,
        "archived": true
      }
    ],
    "operators": [
      {
        "id": "0f0f0000-0000-4000-8000-000000000001",
        "login": "0042",
        "name": "Анна Кузнецова",
        "role": "Оператор линии",
        "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
        "active": true
      },
      {
        "id": "0f0f0000-0000-4000-8000-000000000002",
        "login": "117",
        "name": "Пётр Сидоров",
        "role": null,
        "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tdHdvIQ==$QVZc+yU8wJn39tbKU3wt1Q2wIycAv4j5TS8wJZxy3u8=",
        "active": false
      },
      {
        "id": "0f0f0000-0000-4000-8000-000000000004",
        "login": "205",
        "name": "Ольга Архивная",
        "role": null,
        "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
        "active": false
      }
    ],
    "badges": [
      {
        "id": "0b0b0000-0000-4000-8000-000000000001",
        "operatorId": "0f0f0000-0000-4000-8000-000000000001",
        "badgePhc": "pbkdf2$sha256$100000$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo=",
        "label": "Пропуск 1"
      },
      {
        "id": "0b0b0000-0000-4000-8000-000000000002",
        "operatorId": "0f0f0000-0000-4000-8000-000000000001",
        "badgePhc": "pbkdf2$sha256$100000$bWFya2lyby1iYWRnZS0wMQ==$5wci3Wka6fKZDuXLxiSxhZ+gzdMQw/NMSbCU7QI3xOQ=",
        "label": null
      },
      {
        "id": "0b0b0000-0000-4000-8000-000000000003",
        "operatorId": "0f0f0000-0000-4000-8000-000000000002",
        "badgePhc": "pbkdf2$sha256$100000$bWFya2lyby1iYWRnZS0wMQ==$iQQaQcgfnmironGPSppRAC7eD2OKnyBx2k5/EU/0MLE=",
        "label": "Запасной бейдж"
      }
    ],
    "ssccCounters": [
      {
        "issuerPrefix": "460068200",
        "extension": 0,
        "nextSerial": 30000
      },
      {
        "issuerPrefix": "460068200",
        "extension": 1,
        "nextSerial": 10000
      },
      {
        "issuerPrefix": "460123400",
        "extension": 0,
        "nextSerial": 1
      }
    ],
    "shiftNumberCounters": [
      {
        "monthKey": "NOV26",
        "lastSeq": 1
      },
      {
        "monthKey": "OCT26",
        "lastSeq": 7
      },
      {
        "monthKey": "SEP26",
        "lastSeq": 41
      }
    ]
  },
  "cutover": {
    "boxWindow": 1000000,
    "palletWindow": 100000,
    "ssccCounters": [
      {
        "issuerPrefix": "460068200",
        "extension": 0,
        "owner": {
          "kind": "organization"
        },
        "issuedMax": 21003,
        "printedMax": 21003,
        "standaloneStart": 30000,
        "cloudReseedTo": 1030000
      },
      {
        "issuerPrefix": "460068200",
        "extension": 1,
        "owner": {
          "kind": "organization"
        },
        "issuedMax": 400,
        "printedMax": 250,
        "standaloneStart": 10000,
        "cloudReseedTo": 110000
      },
      {
        "issuerPrefix": "460123400",
        "extension": 0,
        "owner": {
          "kind": "counterparty",
          "id": "0c0c0000-0000-4000-8000-000000000001",
          "name": "ООО «Берег»"
        },
        "issuedMax": null,
        "printedMax": null,
        "standaloneStart": 1,
        "cloudReseedTo": 1000001
      }
    ]
  },
  "notes": [
    {
      "code": "gs1_prefix_dropped",
      "entity": "organization",
      "value": "46x"
    },
    {
      "code": "line_renamed",
      "id": "0a0a0000-0000-4000-8000-000000000003",
      "from": " линия 1 ",
      "to": "линия 1 (2)"
    },
    {
      "code": "counterparty_dropped",
      "id": "0c0c0000-0000-4000-8000-000000000002",
      "reason": "gln"
    },
    {
      "code": "inn_dropped",
      "entity": "counterparties",
      "id": "0c0c0000-0000-4000-8000-000000000003"
    },
    {
      "code": "counterparty_notes_lost",
      "count": 1
    },
    {
      "code": "template_dropped",
      "id": "0d0d0000-0000-4000-8000-000000000006",
      "reason": "spec_not_object"
    },
    {
      "code": "template_default_dropped",
      "purpose": "box",
      "chzProductGroupCode": 13,
      "templateId": "0d0d0000-0000-4000-8000-000000000005"
    },
    {
      "code": "text_changed",
      "entity": "products",
      "id": "0e0e0000-0000-4000-8000-000000000002",
      "field": "name"
    },
    {
      "code": "product_value_cleared",
      "id": "0e0e0000-0000-4000-8000-000000000002",
      "field": "palletBoxCapacity"
    },
    {
      "code": "product_value_cleared",
      "id": "0e0e0000-0000-4000-8000-000000000002",
      "field": "shelfLifeDays"
    },
    {
      "code": "product_template_dropped",
      "id": "0e0e0000-0000-4000-8000-000000000003",
      "templateId": "0d0d0000-0000-4000-8000-000000000004"
    },
    {
      "code": "product_dropped",
      "id": "0e0e0000-0000-4000-8000-000000000004",
      "reason": "gtin"
    },
    {
      "code": "product_fields_lost",
      "field": "egaisCode",
      "count": 1
    },
    {
      "code": "product_fields_lost",
      "field": "externalRef",
      "count": 1
    },
    {
      "code": "product_fields_lost",
      "field": "price",
      "count": 1
    },
    {
      "code": "text_changed",
      "entity": "operators",
      "id": "0f0f0000-0000-4000-8000-000000000002",
      "field": "name"
    },
    {
      "code": "operator_dropped",
      "id": "0f0f0000-0000-4000-8000-000000000003",
      "reason": "login"
    },
    {
      "code": "operator_dropped",
      "id": "0f0f0000-0000-4000-8000-000000000005",
      "reason": "pin"
    },
    {
      "code": "badge_dropped",
      "id": "0b0b0000-0000-4000-8000-000000000005",
      "reason": "operator"
    },
    {
      "code": "badge_dropped",
      "id": "0b0b0000-0000-4000-8000-000000000004",
      "reason": "code"
    },
    {
      "code": "badges_rehashed",
      "count": 2
    },
    {
      "code": "badges_not_operators",
      "count": 2
    },
    {
      "code": "counterparty_sscc_used",
      "count": 1
    },
    {
      "code": "planned_shifts_not_moved",
      "count": 2
    }
  ]
}
```

Создать `tools/standalone-export/test/transform.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canonicalJson, fileChecksum } from "../canonical.mjs";
import { hashBadge, isBadgePhcUnder, parsePhc } from "../phc.mjs";
import { ExportError, buildExportFile, depthOf, plainText } from "../transform.mjs";

const raw = () =>
  JSON.parse(readFileSync(new URL("./fixtures/raw-cloud.json", import.meta.url), "utf8"));
const golden = () =>
  JSON.parse(
    readFileSync(
      new URL("../../../apps/standalone/proto/fixtures/cloud-export-file.json", import.meta.url),
      "utf8",
    ),
  );
const EXPORTED_AT = "2026-10-09T18:30:00.000Z";
const SALT = "bWFya2lyby1iYWRnZS0wMQ==";

test("the raw fixture becomes the golden file the office and the host read", () => {
  const file = buildExportFile(raw(), { exportedAt: EXPORTED_AT });
  assert.deepEqual(file, golden());
  assert.equal(file.checksum, fileChecksum(file));
  assert.match(file.checksum, /^sha256:[0-9a-f]{64}$/u);
});

test("the checksum covers the whole file but its own field, in any key order", () => {
  const file = golden();
  const reordered = Object.fromEntries(Object.entries(file).reverse());
  assert.equal(fileChecksum(reordered), file.checksum);
  assert.notEqual(fileChecksum({ ...file, exportedAt: "2026-10-09T18:30:01.000Z" }), file.checksum);
  assert.notEqual(
    fileChecksum({ ...file, payload: { ...file.payload, badgeSalt: null } }),
    file.checksum,
  );
  assert.equal(fileChecksum({ ...file, checksum: "sha256:0" }), file.checksum);
  assert.equal(
    canonicalJson({ b: [1, { d: null, c: "я" }], a: true }),
    '{"a":true,"b":[1,{"c":"я","d":null}]}',
  );
});

test("badges keep a current hash, are hashed again from a trimmed code, and never carry the code", () => {
  const file = buildExportFile(raw(), { exportedAt: EXPORTED_AT });
  const [kept, missing, legacy] = file.payload.badges;
  assert.equal(kept.badgePhc, raw().badges[0].badgeHash);
  assert.equal(missing.badgePhc, hashBadge("MRK-000743", SALT));
  assert.equal(legacy.badgePhc, hashBadge("MRK-000744", SALT));
  for (const badge of file.payload.badges) assert.ok(isBadgePhcUnder(badge.badgePhc, SALT));
  const text = JSON.stringify(file);
  for (const code of ["MRK-000742", "MRK-000743", "MRK-000744", "МРК-1", "MRK-000746"]) {
    assert.ok(!text.includes(code), `the file holds the badge code ${code}`);
  }
});

test("a current hash of a code with blanks around it is hashed again from the trimmed code", () => {
  const source = raw();
  source.badges[0].badgeCode = " MRK-000742 ";
  source.badges[0].badgeHash = hashBadge(" MRK-000742 ", SALT);
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.badges[0].badgePhc, hashBadge("MRK-000742", SALT));
  assert.ok(file.notes.some((note) => note.code === "badges_rehashed" && note.count === 3));
});

test("a PIN hash moves byte for byte, and one the host would refuse drops its operator", () => {
  const file = buildExportFile(raw(), { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.operators[0].pinPhc, raw().operators[0].pinHash);
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$9999$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$1000001$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$10000$bWFya2lyby1waW4tc2FsdA$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$1000000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    )?.iterations,
    1_000_000,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$10000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    )?.iterations,
    10_000,
  );
});

test("an operator is active only while both the credential and the employee are", () => {
  const source = raw();
  source.operators[0].employeeStatus = "archived";
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.operators.map((operator) => [operator.login, operator.active]),
    [
      ["0042", false],
      ["117", false],
      ["205", false],
    ],
  );
  assert.equal(golden().payload.operators[0].active, true);
});

test("free text loses control characters and is cut to the host's length in code points", () => {
  assert.equal(plainText("Пётр\tСидоров", 100), "Пётр Сидоров");
  assert.equal(plainText("\u0085 имя \u0000", 100), "имя");
  assert.equal(plainText("абв", 3), "абв");
  assert.equal(plainText("абвг", 3), "абв");
  assert.equal(plainText("😀😀😀😀", 3), "😀😀😀");
  assert.equal(plainText("ab cd", 3), "ab");
  assert.equal(plainText(null, 3), "");
});

test("a layout deeper than 64 levels or larger than 256 KB is left out; one at the bound stays", () => {
  const nest = (levels) => {
    let value = {};
    for (let level = 1; level < levels; level += 1) value = { e: value };
    return value;
  };
  assert.equal(depthOf(nest(64)), 64);
  assert.equal(depthOf({ a: [1, { b: [] }] }), 4);
  const base = { widthMm: 58, text: "" };
  const sized = (bytes) => ({ ...base, text: "x".repeat(bytes - JSON.stringify(base).length) });
  assert.equal(Buffer.byteLength(JSON.stringify(sized(262_144))), 262_144);
  const source = raw();
  const template = source.templates[0];
  source.templates = [
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a1", spec: nest(64) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a2", spec: nest(65) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a3", spec: sized(262_144) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a4", spec: sized(262_145) },
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.templates.map((each) => each.id),
    ["0d0d0000-0000-4000-8000-0000000000a1", "0d0d0000-0000-4000-8000-0000000000a3"],
  );
  assert.deepEqual(
    file.notes.filter((note) => note.code === "template_dropped"),
    [
      {
        code: "template_dropped",
        id: "0d0d0000-0000-4000-8000-0000000000a2",
        reason: "spec_too_deep",
      },
      {
        code: "template_dropped",
        id: "0d0d0000-0000-4000-8000-0000000000a4",
        reason: "spec_too_large",
      },
    ],
  );
});

test("a capacity or a shelf life is kept up to the host's bound and cleared past it", () => {
  const source = raw();
  const product = source.products[0];
  source.products = [
    { ...product, boxCapacity: 100_000, palletBoxCapacity: 10_000, shelfLifeDays: 3_650 },
    {
      ...product,
      id: "0e0e0000-0000-4000-8000-0000000000b2",
      gtin14: "04600682000044",
      boxCapacity: 100_001,
      palletBoxCapacity: 10_001,
      shelfLifeDays: 3_651,
    },
    {
      ...product,
      id: "0e0e0000-0000-4000-8000-0000000000b3",
      gtin14: "04600682000051",
      boxCapacity: 0,
    },
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.products.map((each) => [
      each.boxCapacity,
      each.palletBoxCapacity,
      each.shelfLifeDays,
    ]),
    [
      [100_000, 10_000, 3_650],
      [null, null, null],
      [null, 40, 10],
    ],
  );
});

test("at most ten distinct GS1 prefixes of 4–12 digits stay", () => {
  const source = raw();
  source.orgProfile.gs1Prefixes = [
    ...Array.from({ length: 10 }, (_, index) => `46000${index}`),
    "460000",
    "4600099",
    "460",
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.organization.gs1Prefixes.length, 10);
  assert.deepEqual(
    file.notes.filter((note) => note.code === "gs1_prefix_dropped").map((note) => note.value),
    ["4600099", "460"],
  );
});

test("a default the slot would refuse is left out with a note", () => {
  const source = raw();
  source.orgProfile.defaultBoxTemplateId = "0d0d0000-0000-4000-8000-000000000002";
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.templateDefaults.defaultBoxTemplateId, null);
  assert.ok(
    file.notes.some(
      (note) =>
        note.code === "template_default_dropped" &&
        note.purpose === "box" &&
        note.chzProductGroupCode === null,
    ),
  );
});

test("a tenant without a salt gets a new one, and every badge is hashed under it", () => {
  const source = raw();
  source.badgeSalt = null;
  const file = buildExportFile(source, {
    exportedAt: EXPORTED_AT,
    randomBytes: () => Buffer.from("fresh-site-salt!"),
  });
  const salt = Buffer.from("fresh-site-salt!").toString("base64");
  assert.equal(file.payload.badgeSalt, salt);
  assert.deepEqual(
    file.payload.badges.map((badge) => badge.badgePhc),
    [hashBadge("MRK-000742", salt), hashBadge("MRK-000743", salt), hashBadge("MRK-000744", salt)],
  );
  assert.ok(file.notes.some((note) => note.code === "badge_salt_created"));
  assert.ok(file.notes.some((note) => note.code === "badges_rehashed" && note.count === 3));
});

test("an active shift or an unsynced station stops the export, unless it is a rehearsal", () => {
  const one = raw();
  one.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }];
  assert.throws(
    () => buildExportFile(one, { exportedAt: EXPORTED_AT }),
    (error) => error instanceof ExportError && error.code === "cloud_not_clean",
  );
  const source = raw();
  source.activeShifts = [{ monthKey: "OCT26", seq: 8, createdFrom: "station" }];
  source.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }];
  assert.throws(
    () => buildExportFile(source, { exportedAt: EXPORTED_AT }),
    (error) =>
      error instanceof ExportError &&
      error.code === "cloud_not_clean" &&
      JSON.stringify(error.blockers) ===
        JSON.stringify([
          { code: "active_shift", number: "OCT26-008/S" },
          {
            code: "device_out_of_sync",
            id: "0a0d0000-0000-4000-8000-000000000001",
            name: "Станция 1",
          },
        ]),
  );
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT, rehearsal: true });
  assert.equal(file.rehearsal, true);
  assert.deepEqual(file.notes.slice(0, 2), [
    { code: "active_shift", number: "OCT26-008/S" },
    { code: "device_out_of_sync", id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" },
  ]);
});

test("no file without a tenant, a profile, a 13-digit GLN or an organization name", () => {
  const cases = [
    [(source) => (source.tenant = null), "tenant_not_found"],
    [(source) => (source.orgProfile = null), "org_profile_missing"],
    [(source) => (source.orgProfile.gln = null), "org_gln_missing"],
    [(source) => (source.orgProfile.gln = "460068200001"), "org_gln_missing"],
    [(source) => (source.tenant.name = " \t "), "org_name_missing"],
    [(source) => (source.ssccCounters[0].nextSerial = 10_000_000), "sscc_exhausted"],
  ];
  for (const [change, code] of cases) {
    const source = raw();
    change(source);
    assert.throws(
      () => buildExportFile(source, { exportedAt: EXPORTED_AT }),
      (error) => error instanceof ExportError && error.code === code,
      code,
    );
  }
});
```

- [ ] **Step 2: Запуск — падает**

Run: `node --test tools/standalone-export/test/transform.test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`, `Cannot find module '…/tools/standalone-export/canonical.mjs'`.

- [ ] **Step 3: Реализация**

Создать `tools/standalone-export/phc.mjs`:

<!-- prettier-ignore -->
```js
/**
 * PBKDF2 PHC strings as the standalone host reads them
 * (`apps/standalone/host/src/secrets.rs`, `parse_phc`): `pbkdf2$sha256$<n>$<salt>$<digest>`,
 * canonical standard base64 with padding, a 16-byte salt, a 32-byte digest
 * and 10 000–1 000 000 iterations written without a leading zero. The cloud
 * writes PINs and badges in the same format (`apps/api/src/lib/pin-hash.ts`,
 * `badge-salt.ts`), so a hash moves byte for byte; a string the host would
 * refuse is caught here, where the file is made.
 */

import { pbkdf2Sync } from "node:crypto";

/** A badge verifier carries exactly the domain's count (`BADGE_ITERATIONS`). */
export const BADGE_ITERATIONS = 100_000;
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 1_000_000;

/** `bytes` decoded from `text` when `text` is their canonical base64, else `null`. */
export function decodeCanonical(text, bytes) {
  if (typeof text !== "string") return null;
  const decoded = Buffer.from(text, "base64");
  return decoded.length === bytes && decoded.toString("base64") === text ? decoded : null;
}

/** The parts of a PHC string the host accepts, or `null`. */
export function parsePhc(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const [, , count, salt, digest] = parts;
  if (!/^[1-9]\d*$/u.test(count)) return null;
  const iterations = Number(count);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  if (decodeCanonical(salt, 16) === null || decodeCanonical(digest, 32) === null) return null;
  return { iterations, salt, digest };
}

/** Whether a badge verifier is the one `hashBadge` would write under `salt`. */
export function isBadgePhcUnder(text, salt) {
  const parsed = parsePhc(text);
  return parsed !== null && parsed.iterations === BADGE_ITERATIONS && parsed.salt === salt;
}

/** The badge verifier of `code` under the tenant's `salt` (base64), as the cloud's `hashBadgeWithSalt`. */
export function hashBadge(code, salt) {
  const digest = pbkdf2Sync(code, Buffer.from(salt, "base64"), BADGE_ITERATIONS, 32, "sha256");
  return `pbkdf2$sha256$${BADGE_ITERATIONS}$${salt}$${digest.toString("base64")}`;
}
```

Создать `tools/standalone-export/canonical.mjs`:

<!-- prettier-ignore -->
```js
/**
 * The file's checksum: SHA-256 of the canonical JSON of the whole file
 * without its `checksum` field. Canonical JSON writes object keys sorted
 * (JavaScript's default order), no spaces, and values as `JSON.stringify`
 * writes them, so the office (`apps/standalone/src/host/cloud-import.ts`),
 * which parses the file and computes the same text, gets the same digest
 * whatever order or whitespace the file has on disk.
 */

import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` of the file without `checksum`. */
export function fileChecksum(file) {
  const { checksum: _ignored, ...rest } = file;
  return `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
}
```

Создать `tools/standalone-export/transform.mjs`:

<!-- prettier-ignore -->
```js
/**
 * From what `export.sql` read to the import file (pilot spec §8.2, §8.7).
 *
 * The file's `payload` is exactly what `POST /v1/office/import` takes
 * (`markiro_proto::cloud_import::CloudImportPayload`): every value already
 * passes the standalone host's rules, so the host can refuse the whole file
 * on any row that does not (that means a damaged file or a bug, never data).
 * What the cloud holds and the standalone cannot keep is changed or left out
 * here and named in `notes`, which the office shows before the import. The
 * file carries PIN and badge hashes and the badge salt, never a badge code:
 * a code is read only to hash it again, and nothing here logs.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

import { fileChecksum } from "./canonical.mjs";
import { decodeCanonical, hashBadge, isBadgePhcUnder, parsePhc } from "./phc.mjs";
import { BOX_WINDOW, PALLET_WINDOW, planShiftNumberCounters, planSsccCounters } from "./sscc.mjs";

export const FILE_FORMAT = "markiro-cloud-export";
export const FILE_FORMAT_VERSION = 1;
export const TOOL = "standalone-export/1";

/** The host's bounds (`apps/standalone/host/src/validate.rs`). */
const MAX_BOX_CAPACITY = 100_000;
const MAX_PALLET_BOX_CAPACITY = 10_000;
const MAX_SHELF_LIFE_DAYS = 3_650;
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_SPEC_DEPTH = 64;
const MAX_GS1_PREFIXES = 10;

/** A refusal to write any file: the data cannot become a site. */
export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}

/**
 * Free text as the host takes it: every control character (`\p{Cc}`, which
 * is Rust's `char::is_control`) becomes a space, the ends are trimmed, and at
 * most `max` characters (code points, as the host counts them) are kept.
 */
export function plainText(text, max) {
  const replaced = Array.from(text ?? "", (char) => (/\p{Cc}/u.test(char) ? " " : char))
    .join("")
    .trim();
  const chars = Array.from(replaced);
  return chars.length > max ? chars.slice(0, max).join("").trim() : replaced;
}

/** How deep a value nests: an object or an array is a level, a scalar none. */
export function depthOf(value) {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (value !== null && typeof value === "object") {
    return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  }
  return 0;
}

/** An INN of 10 or 12 digits after trimming, else `null`. */
function innOf(text) {
  const inn = (text ?? "").trim();
  return /^(?:\d{10}|\d{12})$/u.test(inn) ? inn : null;
}

/** GS1 prefixes as the host keeps them: trimmed, 4–12 digits, distinct, at most 10. */
function prefixesOf(values, note) {
  const kept = [];
  for (const value of values ?? []) {
    const prefix = value.trim();
    if (kept.includes(prefix)) continue;
    if (!/^\d{4,12}$/u.test(prefix) || kept.length === MAX_GS1_PREFIXES) {
      note({ value });
      continue;
    }
    kept.push(prefix);
  }
  return kept;
}

/** A count within 1..=`max`, else `null`. */
function countOf(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

/** Whether a template may stand in the slot of `purpose` for `category` (`null`: the organization's), as the host's `templates::fits`. */
function fits(template, purpose, category) {
  if (!template.enabled || template.purpose !== purpose) return false;
  if (template.chzProductGroupCodes === null) return true;
  return category !== null && template.chzProductGroupCodes.includes(category);
}

function formatShiftNumber({ monthKey, seq, createdFrom }) {
  return `${monthKey}-${String(seq).padStart(3, "0")}${createdFrom === "station" ? "/S" : ""}`;
}

/**
 * The import file of `raw`. Throws `ExportError` when no file can be made
 * (no tenant, no organization profile or GLN, a used-up prefix) and, unless
 * `rehearsal`, when the cloud is not clean (an active shift, a station with a
 * live block that has not synced since the last close: pilot spec §8.6).
 */
export function buildExportFile(raw, options) {
  const {
    exportedAt,
    rehearsal = false,
    windows = { box: BOX_WINDOW, pallet: PALLET_WINDOW },
    randomBytes = nodeRandomBytes,
  } = options;
  const notes = [];
  const note = (entry) => notes.push(entry);

  if (raw.tenant === null) throw new ExportError("tenant_not_found", "no such tenant");
  if (raw.orgProfile === null) {
    throw new ExportError("org_profile_missing", "the tenant has no organization profile");
  }
  const gln = (raw.orgProfile.gln ?? "").trim();
  if (!/^\d{13}$/u.test(gln)) {
    throw new ExportError("org_gln_missing", "the organization profile has no 13-digit GLN");
  }
  const orgName = plainText(raw.tenant.name, 200);
  if (orgName === "") throw new ExportError("org_name_missing", "the organization has no name");

  const blockers = [
    ...raw.activeShifts.map((shift) => ({
      code: "active_shift",
      number: formatShiftNumber(shift),
    })),
    ...raw.staleDevices.map((device) => ({
      code: "device_out_of_sync",
      id: device.id,
      name: device.name,
    })),
  ];
  if (blockers.length > 0 && !rehearsal) {
    const error = new ExportError(
      "cloud_not_clean",
      "the cloud has an active shift or an unsynced station",
    );
    error.blockers = blockers;
    throw error;
  }
  for (const blocker of blockers) note(blocker);

  // Organization.
  if (orgName !== raw.tenant.name)
    note({ code: "text_changed", entity: "organization", field: "name" });
  const orgInn = innOf(raw.orgProfile.inn);
  if (orgInn === null && raw.orgProfile.inn !== null) {
    note({ code: "inn_dropped", entity: "organization" });
  }
  const orgPrefixes = prefixesOf(raw.orgProfile.gs1Prefixes, ({ value }) =>
    note({ code: "gs1_prefix_dropped", entity: "organization", value }),
  );
  let timeZone = (raw.orgProfile.timeZone ?? "").trim();
  if (!/^[A-Za-z0-9/_+-]{1,64}$/u.test(timeZone)) {
    note({ code: "time_zone_replaced", value: raw.orgProfile.timeZone });
    timeZone = "Europe/Moscow";
  }
  const organization = { name: orgName, inn: orgInn, gln, gs1Prefixes: orgPrefixes, timeZone };

  // Lines: a name the host keys without case once only (« (2)» after the second).
  const lines = [];
  const lineKeys = new Set();
  for (const line of raw.lines) {
    const name = plainText(line.name, 100);
    if (name === "") {
      note({ code: "line_dropped", id: line.id });
      continue;
    }
    let unique = name;
    for (let n = 2; lineKeys.has(unique.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      unique = `${Array.from(name)
        .slice(0, 100 - suffix.length)
        .join("")
        .trim()}${suffix}`;
    }
    if (unique !== line.name)
      note({ code: "line_renamed", id: line.id, from: line.name, to: unique });
    lineKeys.add(unique.toLowerCase());
    lines.push({ id: line.id, name: unique });
  }

  // Counterparties.
  const counterparties = [];
  let counterpartyNotes = 0;
  for (const each of raw.counterparties) {
    if (each.hasNotes) counterpartyNotes += 1;
    const cpGln = (each.gln ?? "").trim();
    const name = plainText(each.name, 200);
    if (!/^\d{13}$/u.test(cpGln) || name === "") {
      note({ code: "counterparty_dropped", id: each.id, reason: name === "" ? "name" : "gln" });
      continue;
    }
    if (name !== each.name)
      note({ code: "text_changed", entity: "counterparties", id: each.id, field: "name" });
    const inn = innOf(each.inn);
    if (inn === null && each.inn !== null)
      note({ code: "inn_dropped", entity: "counterparties", id: each.id });
    const gs1Prefixes = prefixesOf(each.gs1Prefixes, ({ value }) =>
      note({ code: "gs1_prefix_dropped", entity: "counterparties", id: each.id, value }),
    );
    counterparties.push({ id: each.id, name, inn, gln: cpGln, gs1Prefixes });
  }
  if (counterpartyNotes > 0) note({ code: "counterparty_notes_lost", count: counterpartyNotes });

  // Templates.
  const templates = [];
  const templateById = new Map();
  for (const each of raw.templates) {
    const name = plainText(each.name, 200);
    let reason = null;
    if (name === "") reason = "name";
    else if (each.spec === null || typeof each.spec !== "object" || Array.isArray(each.spec)) {
      reason = "spec_not_object";
    } else if (depthOf(each.spec) > MAX_SPEC_DEPTH) reason = "spec_too_deep";
    else if (Buffer.byteLength(JSON.stringify(each.spec), "utf8") > MAX_SPEC_BYTES) {
      reason = "spec_too_large";
    }
    if (reason !== null) {
      note({ code: "template_dropped", id: each.id, reason });
      continue;
    }
    if (name !== each.name)
      note({ code: "text_changed", entity: "templates", id: each.id, field: "name" });
    const template = {
      id: each.id,
      name,
      purpose: each.purpose,
      enabled: each.enabled,
      chzProductGroupCodes: each.chzProductGroupCodes,
      spec: each.spec,
    };
    templates.push(template);
    templateById.set(template.id, template);
  }

  // Template defaults: only a template that fits its slot, as the host checks.
  const orgDefault = (id, purpose) => {
    if (id === null) return null;
    const template = templateById.get(id);
    if (template !== undefined && fits(template, purpose, null)) return id;
    note({ code: "template_default_dropped", purpose, chzProductGroupCode: null, templateId: id });
    return null;
  };
  const categories = [];
  for (const [purpose, rows] of [
    ["box", raw.boxDefaults],
    ["pallet", raw.palletDefaults],
  ]) {
    for (const row of rows) {
      const template = templateById.get(row.templateId);
      if (template !== undefined && fits(template, purpose, row.chzProductGroupCode)) {
        categories.push({
          chzProductGroupCode: row.chzProductGroupCode,
          purpose,
          templateId: row.templateId,
        });
      } else {
        note({
          code: "template_default_dropped",
          purpose,
          chzProductGroupCode: row.chzProductGroupCode,
          templateId: row.templateId,
        });
      }
    }
  }
  categories.sort((a, b) =>
    a.chzProductGroupCode === b.chzProductGroupCode
      ? a.purpose < b.purpose
        ? -1
        : 1
      : a.chzProductGroupCode - b.chzProductGroupCode,
  );
  const templateDefaults = {
    defaultBoxTemplateId: orgDefault(raw.orgProfile.defaultBoxTemplateId, "box"),
    defaultPalletTemplateId: orgDefault(raw.orgProfile.defaultPalletTemplateId, "pallet"),
    categories,
  };

  // Products.
  const products = [];
  const lost = new Map();
  for (const each of raw.products) {
    for (const field of each.lost) lost.set(field, (lost.get(field) ?? 0) + 1);
    const name = plainText(each.name, 200);
    if (!/^\d{14}$/u.test(each.gtin14) || name === "") {
      note({ code: "product_dropped", id: each.id, reason: name === "" ? "name" : "gtin" });
      continue;
    }
    if (name !== each.name)
      note({ code: "text_changed", entity: "products", id: each.id, field: "name" });
    const printName = each.printName === null ? null : plainText(each.printName, 200) || null;
    if (each.printName !== null && printName !== each.printName) {
      note({ code: "text_changed", entity: "products", id: each.id, field: "printName" });
    }
    const bounded = (field, max) => {
      const value = countOf(each[field], max);
      if (value === null && each[field] !== null)
        note({ code: "product_value_cleared", id: each.id, field });
      return value;
    };
    let defaultBoxTemplateId = null;
    let defaultPalletTemplateId = null;
    if (each.defaultLabelTemplateId !== null) {
      const template = templateById.get(each.defaultLabelTemplateId);
      if (template?.purpose === "box") defaultBoxTemplateId = template.id;
      else if (template?.purpose === "pallet") defaultPalletTemplateId = template.id;
      else
        note({
          code: "product_template_dropped",
          id: each.id,
          templateId: each.defaultLabelTemplateId,
        });
    }
    products.push({
      id: each.id,
      gtin14: each.gtin14,
      name,
      printName,
      chzProductGroupCode: each.chzProductGroupCode,
      boxCapacity: bounded("boxCapacity", MAX_BOX_CAPACITY),
      palletBoxCapacity: bounded("palletBoxCapacity", MAX_PALLET_BOX_CAPACITY),
      shelfLifeDays: bounded("shelfLifeDays", MAX_SHELF_LIFE_DAYS),
      defaultBoxTemplateId,
      defaultPalletTemplateId,
      archived: each.archived,
    });
  }
  for (const [field, count] of [...lost.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    note({ code: "product_fields_lost", field, count });
  }

  // Operators: the PIN hash moves byte for byte (§8.3).
  const operators = [];
  for (const each of raw.operators) {
    const name = plainText(each.fullName, 100);
    let reason = null;
    if (!/^\d{3,12}$/u.test(each.login)) reason = "login";
    else if (parsePhc(each.pinHash) === null) reason = "pin";
    else if (name === "") reason = "name";
    if (reason !== null) {
      note({ code: "operator_dropped", id: each.id, reason });
      continue;
    }
    if (name !== each.fullName)
      note({ code: "text_changed", entity: "operators", id: each.id, field: "name" });
    const role = each.role === null ? null : plainText(each.role, 120) || null;
    if (each.role !== null && role !== each.role) {
      note({ code: "text_changed", entity: "operators", id: each.id, field: "role" });
    }
    operators.push({
      id: each.id,
      login: each.login,
      name,
      role,
      pinPhc: each.pinHash,
      active: each.credentialActive && each.employeeStatus === "active",
    });
  }

  // Badges: the tenant's salt becomes the site's (§8.3, option 1). A badge
  // whose hash is missing or carries another salt is hashed again from its
  // code, as the cloud's `activeBadgeHashes` does; a code a station could not
  // read (not 1–256 printable ASCII after trimming) is left out.
  const operatorIds = new Set(operators.map((operator) => operator.id));
  const kept = raw.badges.filter((badge) => {
    if (operatorIds.has(badge.operatorId)) return true;
    note({ code: "badge_dropped", id: badge.id, reason: "operator" });
    return false;
  });
  let badgeSalt = decodeCanonical(raw.badgeSalt, 16) === null ? null : raw.badgeSalt;
  if (badgeSalt === null && kept.length > 0) {
    badgeSalt = randomBytes(16).toString("base64");
    note({ code: "badge_salt_created" });
  }
  const badges = [];
  const phcs = new Set();
  let rehashed = 0;
  for (const each of kept) {
    const code = each.badgeCode.trim();
    if (!/^[ -~]{1,256}$/u.test(code)) {
      note({ code: "badge_dropped", id: each.id, reason: "code" });
      continue;
    }
    let badgePhc = each.badgeHash;
    if (code !== each.badgeCode || !isBadgePhcUnder(badgePhc, badgeSalt)) {
      badgePhc = hashBadge(code, badgeSalt);
      rehashed += 1;
    }
    if (phcs.has(badgePhc)) {
      note({ code: "badge_dropped", id: each.id, reason: "duplicate" });
      continue;
    }
    phcs.add(badgePhc);
    const label = each.label === null ? null : plainText(each.label, 100) || null;
    badges.push({ id: each.id, operatorId: each.operatorId, badgePhc, label });
  }
  if (rehashed > 0) note({ code: "badges_rehashed", count: rehashed });
  if (raw.nonOperatorBadges > 0)
    note({ code: "badges_not_operators", count: raw.nonOperatorBadges });

  // SSCC and shift numbers (§8.4, §8.5).
  const owners = (prefix) => {
    if (prefix === gln.slice(0, 9)) return { kind: "organization" };
    const counterparty = counterparties.find((each) => each.gln.slice(0, 9) === prefix);
    return counterparty === undefined
      ? { kind: "unknown" }
      : { kind: "counterparty", id: counterparty.id, name: counterparty.name };
  };
  let cutoverCounters;
  try {
    cutoverCounters = planSsccCounters(
      { counters: raw.ssccCounters, blocks: raw.ssccBlocks, printed: raw.ssccPrinted },
      owners,
      windows,
    );
  } catch (error) {
    throw new ExportError("sscc_exhausted", error.message);
  }
  for (const row of cutoverCounters) {
    if (row.cloudReseedTo === null) {
      note({
        code: "sscc_window_does_not_fit",
        issuerPrefix: row.issuerPrefix,
        extension: row.extension,
      });
    }
  }
  if (raw.counterpartyIssuedShifts > 0) {
    note({ code: "counterparty_sscc_used", count: raw.counterpartyIssuedShifts });
  }
  if (raw.plannedShifts > 0) note({ code: "planned_shifts_not_moved", count: raw.plannedShifts });

  const payload = {
    organization,
    badgeSalt,
    lines,
    counterparties,
    templates,
    templateDefaults,
    products,
    operators,
    badges,
    ssccCounters: cutoverCounters.map((row) => ({
      issuerPrefix: row.issuerPrefix,
      extension: row.extension,
      nextSerial: row.standaloneStart,
    })),
    shiftNumberCounters: planShiftNumberCounters(raw.shiftNumberCounters),
  };
  const file = {
    format: FILE_FORMAT,
    formatVersion: FILE_FORMAT_VERSION,
    tool: TOOL,
    exportedAt,
    rehearsal,
    checksum: "",
    source: { tenantId: raw.tenant.id, tenantName: orgName },
    payload,
    cutover: {
      boxWindow: windows.box,
      palletWindow: windows.pallet,
      ssccCounters: cutoverCounters,
    },
    notes,
  };
  file.checksum = fileChecksum(file);
  return file;
}
```

- [ ] **Step 4: Запуск — проходит**

Run: `node --test tools/standalone-export/test/sscc.test.mjs tools/standalone-export/test/transform.test.mjs`
Expected: `ℹ tests 22`, `ℹ pass 22`, `ℹ fail 0`.

- [ ] **Step 5: Мутации**

1. В `transform.mjs` `if (code !== each.badgeCode || !isBadgePhcUnder(badgePhc, badgeSalt)) {` → `if (!isBadgePhcUnder(badgePhc, badgeSalt)) {` — FAIL `a current hash of a code with blanks around it is hashed again from the trimmed code`.
2. В `phc.mjs` `parsed.iterations === BADGE_ITERATIONS && parsed.salt === salt` → `parsed.iterations === BADGE_ITERATIONS` — FAIL `the raw fixture becomes the golden file …` и `a tenant without a salt gets a new one …`.
3. В `transform.mjs` `if (blockers.length > 0 && !rehearsal) {` → `if (blockers.length > 1 && !rehearsal) {` — FAIL `an active shift or an unsynced station stops the export, unless it is a rehearsal`.
4. В `transform.mjs` `depthOf(each.spec) > MAX_SPEC_DEPTH` → `depthOf(each.spec) >= MAX_SPEC_DEPTH` — FAIL `a layout deeper than 64 levels or larger than 256 KB is left out; one at the bound stays`.

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check tools/standalone-export apps/standalone/proto/fixtures/cloud-export-file.json
git diff --check
git add tools/standalone-export/phc.mjs tools/standalone-export/canonical.mjs tools/standalone-export/transform.mjs \
  tools/standalone-export/test/transform.test.mjs tools/standalone-export/test/fixtures/raw-cloud.json \
  apps/standalone/proto/fixtures/cloud-export-file.json
git commit -m "feat(standalone): cloud export: the import file, its notes and its checksum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Инструмент выгрузки — `export.sql` по копии базы, CLI, задания CI

`export.sql` читает одного арендатора в один JSON одной транзакцией REPEATABLE READ READ ONLY: каждый запрос отфильтрован `:'tenant_id'`, напечатанные SSCC берутся из коробов и паллет только под префиксами счётчиков и блоков арендатора (чужой SSCC в его данных — не его номер), устаревшая станция — по правилу `findSeedBlocker` (не отозвана, есть живой блок, не была на связи после последнего закрытия смены). Вывод несёт открытые коды бейджей, поэтому `cli.mjs` читает его из stdout `psql` в память и нигде не хранит; подключение — только переменные libpq, пароль в аргументы не попадает; файл пишется с флагом `wx` и правами `0600`; ошибка разбора JSON не цитирует текст. Тест SQL сеет двух арендаторов (у второго — тот же префикс с бо́льшим счётчиком, активная смена, устаревшая станция, бейдж того же кода) и сверяет вывод для первого с `raw-cloud.json` целиком; затем делает смену первого активной и его станцию устаревшей и видит их. В CI чистые тесты идут в `verify-static`, тест SQL — в `verify-api-tests` после миграций облака; классификатор отправляет `tools/standalone-export/` в оба задания.

**Files:**

- Create: `tools/standalone-export/export.sql`, `tools/standalone-export/cli.mjs`
- Create: `tools/standalone-export/test/fixtures/seed-cloud.sql`, `tools/standalone-export/test/fixtures/cleanup-cloud.sql`
- Test: `tools/standalone-export/test/cli.test.mjs`, `tools/standalone-export/test/export-sql.test.mjs` (Create); `tools/ci/test/affected.test.mjs` (Modify)
- Modify: `package.json` (скрипт `test:standalone-export`), `.github/workflows/ci.yml`, `tools/ci/affected.mjs`

**Interfaces:**

- Consumes: `buildExportFile`, `ExportError` (задача 2).
- Produces (`cli.mjs`): `parseArgs(argv): { tenantId, outDir, rehearsal, psql }`; `runPsql({ psql?, tenantId, env? }): Promise<string>`; `parseRaw(text)`; `fileName(file): string`; `summary(file, path): string[]`; `main(argv, deps?): Promise<number>` (0 — файл записан; 1 — сбой; 2 — `ExportError`, в том числе нечистое облако; 64 — неверные аргументы). Командная строка: `node tools/standalone-export/cli.mjs --tenant <tenantId> [--out-dir <dir>] [--rehearsal] [--psql <path>]`.

- [ ] **Step 1: Засев, тесты и классификатор (падающие)**

Создать `tools/standalone-export/test/fixtures/seed-cloud.sql`:

<!-- prettier-ignore -->
```sql
-- Two cloud tenants for test/export-sql.test.mjs: `imp-test-atoll`, whose
-- export must equal test/fixtures/raw-cloud.json, and `imp-test-other`,
-- whose rows (a higher counter under the same prefix, an active shift, a
-- stale station) must not reach it. Fixed ids, so cleanup-cloud.sql removes
-- exactly these rows. Run on a database with the cloud's migrations applied.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO organization (id, name, slug, created_at) VALUES
  ('imp-test-atoll', 'ООО «Атолл»', 'imp-test-atoll', '2026-01-10 09:00:00'),
  ('imp-test-other', 'ООО «Чужой»', 'imp-test-other', '2026-01-10 09:00:00');

INSERT INTO label_templates (id, tenant_id, name, spec, purpose, enabled, chz_product_group_codes, created_at) VALUES
  ('0d0d0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Короб 58×40',
    '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}', 'box', true, NULL, '2026-01-11 09:00:01+00'),
  ('0d0d0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'Короб молочный',
    '{"widthMm":58,"heightMm":60,"dpi":203,"language":"zpl","elements":[]}', 'box', true, '{8}', '2026-01-11 09:00:02+00'),
  ('0d0d0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'Паллета 100×150',
    '{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[]}', 'pallet', true, NULL, '2026-01-11 09:00:03+00'),
  ('0d0d0000-0000-4000-8000-000000000004', 'imp-test-atoll', 'Дубликат',
    '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}', 'product_duplicate', true, NULL, '2026-01-11 09:00:04+00'),
  ('0d0d0000-0000-4000-8000-000000000005', 'imp-test-atoll', 'Старый короб',
    '{"widthMm":58,"heightMm":40,"dpi":300,"language":"tspl","elements":[]}', 'box', false, NULL, '2026-01-11 09:00:05+00'),
  ('0d0d0000-0000-4000-8000-000000000006', 'imp-test-atoll', 'Не макет',
    '["not", "a", "layout"]', 'box', true, NULL, '2026-01-11 09:00:06+00'),
  ('0d0d0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужой короб',
    '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}', 'box', true, NULL, '2026-01-11 09:00:07+00');

INSERT INTO org_profiles (tenant_id, gln, gs1_prefixes, inn, time_zone,
    default_box_label_template_id, default_pallet_label_template_id) VALUES
  ('imp-test-atoll', '4600682000010', '{4600682," 4600682 ",46x}', '7701234567', 'Europe/Moscow',
    '0d0d0000-0000-4000-8000-000000000001', '0d0d0000-0000-4000-8000-000000000003'),
  ('imp-test-other', '4600682000010', '{}', NULL, 'Europe/Moscow', NULL, NULL);

INSERT INTO org_box_label_template_defaults (tenant_id, chz_product_group_code, template_id) VALUES
  ('imp-test-atoll', 8, '0d0d0000-0000-4000-8000-000000000002'),
  ('imp-test-atoll', 13, '0d0d0000-0000-4000-8000-000000000005');
INSERT INTO org_pallet_label_template_defaults (tenant_id, chz_product_group_code, template_id) VALUES
  ('imp-test-atoll', 8, '0d0d0000-0000-4000-8000-000000000003');

INSERT INTO employee_badge_salts (tenant_id, salt) VALUES
  ('imp-test-atoll', 'bWFya2lyby1iYWRnZS0wMQ=='),
  ('imp-test-other', 'b3RoZXItdGVuYW50LXNhbHQ=');

INSERT INTO lines (id, tenant_id, name, created_at) VALUES
  ('0a0a0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Линия 1', '2026-01-12 09:00:01+00'),
  ('0a0a0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'Упаковка', '2026-01-12 09:00:02+00'),
  ('0a0a0000-0000-4000-8000-000000000003', 'imp-test-atoll', ' линия 1 ', '2026-01-12 09:00:03+00'),
  ('0a0a0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужая линия', '2026-01-12 09:00:04+00');

INSERT INTO counterparties (id, tenant_id, name, gln, inn, gs1_prefixes, notes, created_at) VALUES
  ('0c0c0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'ООО «Берег»', '4601234000017',
    '7812345678', '{4601234}', 'договор 12', '2026-01-13 09:00:01+00'),
  ('0c0c0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'ИП Петров', '46012',
    NULL, '{}', NULL, '2026-01-13 09:00:02+00'),
  ('0c0c0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'АО «Дельта»', '4607000000014',
    '12345', '{}', '  ', '2026-01-13 09:00:03+00');

INSERT INTO products (id, tenant_id, gtin14, name, print_name, chz_product_group_code, box_capacity,
    pallet_box_capacity, archived, default_label_template_id, unit_price, egais_code, shelf_life_days,
    external_ref, created_at) VALUES
  ('0e0e0000-0000-4000-8000-000000000001', 'imp-test-atoll', '04600682000013', 'Молоко 3,2% 0,9 л',
    'Молоко 3,2%', 8, 12, 40, false, '0d0d0000-0000-4000-8000-000000000002', 89.90, NULL, 10, NULL,
    '2026-01-14 09:00:01+00'),
  ('0e0e0000-0000-4000-8000-000000000002', 'imp-test-atoll', '04600682000020', 'Вода ' || repeat('я', 200),
    NULL, 13, 6, 100000, false, '0d0d0000-0000-4000-8000-000000000003', NULL, NULL, 5000, 'erp-17',
    '2026-01-14 09:00:02+00'),
  ('0e0e0000-0000-4000-8000-000000000003', 'imp-test-atoll', '04600682000013', 'Молоко (старая карточка)',
    NULL, 8, 12, 40, true, '0d0d0000-0000-4000-8000-000000000004', NULL, '0123', NULL, NULL,
    '2026-01-14 09:00:03+00'),
  ('0e0e0000-0000-4000-8000-000000000004', 'imp-test-atoll', '4600682000037', 'Кефир',
    NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, '2026-01-14 09:00:04+00'),
  ('0e0e0000-0000-4000-8000-000000000099', 'imp-test-other', '04600682000013', 'Чужое молоко',
    NULL, 8, 12, 40, false, NULL, NULL, NULL, NULL, NULL, '2026-01-14 09:00:05+00');

INSERT INTO employees (id, tenant_id, full_name, role, status) VALUES
  ('0f0f0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Анна Кузнецова', 'Оператор линии', 'active'),
  ('0f0f0000-0000-4000-8000-000000000002', 'imp-test-atoll', E'Пётр\tСидоров', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'Илья Короткий', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000004', 'imp-test-atoll', 'Ольга Архивная', NULL, 'archived'),
  ('0f0f0000-0000-4000-8000-000000000005', 'imp-test-atoll', 'Сергей Без-Пина', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000006', 'imp-test-atoll', 'Кладовщик', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужой оператор', NULL, 'active');

INSERT INTO operator_credentials (tenant_id, employee_id, login, pin_hash, active) VALUES
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001', '0042',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000002', '117',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tdHdvIQ==$QVZc+yU8wJn39tbKU3wt1Q2wIycAv4j5TS8wJZxy3u8=', false),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000003', '12',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000004', '205',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000005', '306',
    'pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-other', '0f0f0000-0000-4000-8000-000000000099', '0042',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true);

INSERT INTO employee_badges (id, tenant_id, employee_id, badge_code, label, badge_hash, issued_at, revoked_at) VALUES
  ('0b0b0000-0000-4000-8000-000000000001', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'MRK-000742', 'Пропуск 1',
    'pbkdf2$sha256$100000$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo=',
    '2026-01-15 09:00:01+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000002', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'MRK-000743', NULL, NULL, '2026-01-15 09:00:02+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000003', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000002',
    ' MRK-000744 ', E'Запасной\nбейдж',
    'pbkdf2$sha256$100000$bGVnYWN5LXJvdy1zYWx0IQ==$vULnmFLrlEL53UOHeKzL62/qUqLZKBBI/X0BXSWxx5E=',
    '2026-01-15 09:00:03+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000004', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'МРК-1', NULL, NULL, '2026-01-15 09:00:04+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000005', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000003',
    'MRK-000746', NULL, NULL, '2026-01-15 09:00:05+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000006', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'MRK-000700', NULL, NULL, '2026-01-15 09:00:06+00', '2026-02-01 09:00:00+00'),
  ('0b0b0000-0000-4000-8000-000000000007', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000006',
    'MRK-000900', NULL, NULL, '2026-01-15 09:00:07+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000008', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000006',
    'MRK-000901', NULL, NULL, '2026-01-15 09:00:08+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000099', 'imp-test-other', '0f0f0000-0000-4000-8000-000000000099',
    'MRK-000742', NULL, NULL, '2026-01-15 09:00:09+00', NULL);

INSERT INTO station_devices (id, tenant_id, name, last_seen_at, revoked_at) VALUES
  ('0a0d0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Станция 1', '2026-10-09 18:00:00+00', NULL),
  ('0a0d0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'Старая станция', NULL, '2026-05-01 09:00:00+00'),
  ('0a0d0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужая станция', NULL, NULL);

INSERT INTO sscc_counters (tenant_id, issuer_prefix, extension_digit, next_serial) VALUES
  ('imp-test-atoll', '460068200', 0, 18500),
  ('imp-test-atoll', '460068200', 1, 301),
  ('imp-test-atoll', '460123400', 0, 1),
  ('imp-test-other', '460068200', 0, 900001);

INSERT INTO sscc_blocks (id, allocation_order, tenant_id, issuer_prefix, extension_digit, device_id,
    from_serial, to_serial, consumed_through_serial, revoked_at) VALUES
  ('0bb00000-0000-4000-8000-000000000001', 1, 'imp-test-atoll', '460068200', 0,
    '0a0d0000-0000-4000-8000-000000000002', 18000, 19999, 18750, '2026-05-01 09:00:00+00'),
  ('0bb00000-0000-4000-8000-000000000002', 1, 'imp-test-atoll', '460068200', 0,
    '0a0d0000-0000-4000-8000-000000000001', 16000, 17999, 17999, NULL),
  ('0bb00000-0000-4000-8000-000000000003', 1, 'imp-test-atoll', '460068200', 1,
    '0a0d0000-0000-4000-8000-000000000001', 201, 400, 250, NULL),
  ('0bb00000-0000-4000-8000-000000000099', 1, 'imp-test-other', '460068200', 0,
    '0a0d0000-0000-4000-8000-000000000099', 900000, 900000, NULL, NULL);

INSERT INTO shifts (id, tenant_id, product_id, line_id, mode, status, number_month_key, number_seq,
    sscc_issuer_counterparty_id, closed_at) VALUES
  ('05050000-0000-4000-8000-000000000001', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000001', 'aggregation', 'closed', 'OCT26', 6, NULL, '2026-10-09 17:00:00+00'),
  ('05050000-0000-4000-8000-000000000002', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000001', 'aggregation', 'planned', 'OCT26', 7, NULL, NULL),
  ('05050000-0000-4000-8000-000000000003', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000002', 'aggregation', 'planned', 'NOV26', 1, NULL, NULL),
  ('05050000-0000-4000-8000-000000000004', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000001', 'aggregation', 'closed', 'SEP26', 41,
    '0c0c0000-0000-4000-8000-000000000001', '2026-09-30 17:00:00+00'),
  ('05050000-0000-4000-8000-000000000099', 'imp-test-other', '0e0e0000-0000-4000-8000-000000000099',
    '0a0a0000-0000-4000-8000-000000000099', 'aggregation', 'active', 'OCT26', 3, NULL, NULL);

INSERT INTO pallets (id, tenant_id, shift_id, device_pallet_id, sscc) VALUES
  ('0b0d0000-0000-4000-8000-000000000001', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'pallet-1', '146006820000002502');

INSERT INTO boxes (id, tenant_id, shift_id, device_box_id, sscc) VALUES
  ('0b0c0000-0000-4000-8000-000000000001', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-1', '046006820000187509'),
  ('0b0c0000-0000-4000-8000-000000000002', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-2', '046006820000210030'),
  ('0b0c0000-0000-4000-8000-000000000003', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-3', '046099990000007777'),
  ('0b0c0000-0000-4000-8000-000000000004', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-4', NULL),
  ('0b0c0000-0000-4000-8000-000000000099', 'imp-test-other', '05050000-0000-4000-8000-000000000099',
    'box-99', '046006820009000007');

INSERT INTO shift_number_counters (tenant_id, month_key, last_seq) VALUES
  ('imp-test-atoll', 'SEP26', 41),
  ('imp-test-atoll', 'OCT26', 7),
  ('imp-test-atoll', 'NOV26', 1),
  ('imp-test-atoll', 'DEC26', 0),
  ('imp-test-other', 'OCT26', 3);

COMMIT;
```

Создать `tools/standalone-export/test/fixtures/cleanup-cloud.sql`:

<!-- prettier-ignore -->
```sql
-- Removes what seed-cloud.sql inserted, children first; harmless when
-- nothing is there, so the test runs it before seeding and after.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM boxes WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM pallets WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM shifts WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM sscc_blocks WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM sscc_counters WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM station_devices WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM shift_number_counters WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM employee_badges WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM operator_credentials WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM employees WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM employee_badge_salts WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM products WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM org_box_label_template_defaults WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM org_pallet_label_template_defaults WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM org_profiles WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM label_templates WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM counterparties WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM lines WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM organization WHERE id IN ('imp-test-atoll', 'imp-test-other');
COMMIT;
```

Создать `tools/standalone-export/test/cli.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fileName, main, parseArgs } from "../cli.mjs";

const rawText = readFileSync(new URL("./fixtures/raw-cloud.json", import.meta.url), "utf8");
const golden = JSON.parse(
  readFileSync(
    new URL("../../../apps/standalone/proto/fixtures/cloud-export-file.json", import.meta.url),
    "utf8",
  ),
);

/** `main` with psql replaced by `output` and the console captured. */
async function run(argv, output = rawText) {
  const out = [];
  const err = [];
  const calls = [];
  const code = await main(argv, {
    run: async (options) => {
      calls.push(options);
      return output;
    },
    now: () => new Date("2026-10-09T18:30:00.000Z"),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: { PGHOST: "restored-copy" },
  });
  return { code, out, err, calls };
}

test("arguments: a tenant is required and nothing unknown is taken", () => {
  assert.deepEqual(parseArgs(["--tenant", "imp-test-atoll"]), {
    tenantId: "imp-test-atoll",
    outDir: ".",
    rehearsal: false,
    psql: "psql",
  });
  assert.deepEqual(
    parseArgs(["--rehearsal", "--tenant", "t1", "--out-dir", "/media/usb", "--psql", "/opt/psql"]),
    { tenantId: "t1", outDir: "/media/usb", rehearsal: true, psql: "/opt/psql" },
  );
  assert.throws(() => parseArgs([]), /--tenant/u);
  assert.throws(() => parseArgs(["--tenant", "a'b"]), /--tenant/u);
  assert.throws(() => parseArgs(["--tenant"]), /needs a value/u);
  assert.throws(() => parseArgs(["--tenant", "t1", "--password", "x"]), /unknown argument/u);
});

test("the file is written owner-only under its name and the summary names no secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const { code, out, err, calls } = await run(["--tenant", "imp-test-atoll", "--out-dir", dir]);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(calls, [
      { psql: "psql", tenantId: "imp-test-atoll", env: { PGHOST: "restored-copy" } },
    ]);
    const path = join(dir, "markiro-cloud-export-7701234567-2026-10-09.json");
    assert.equal(fileName(golden), "markiro-cloud-export-7701234567-2026-10-09.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), golden);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(out, [
      `Файл: ${path}`,
      "Организация: ООО «Атолл», ИНН 7701234567, GLN 4600682000010, часовой пояс Europe/Moscow",
      "Записей: линий 3, контрагентов 2, шаблонов 5, товаров 3, операторов 3, бейджей 3",
      "Номера смен: NOV26 → 1, OCT26 → 7, SEP26 → 41",
      "SSCC (префикс, расширение, владелец):",
      "  460068200, короба (0), организация: выдано облаком до 21003, напечатано до 21003, автоном начнёт с 30000, облако перевести на 1030000",
      "  460068200, паллеты (1), организация: выдано облаком до 400, напечатано до 250, автоном начнёт с 10000, облако перевести на 110000",
      "  460123400, короба (0), контрагент «ООО «Берег»»: выдано облаком до —, напечатано до —, автоном начнёт с 1, облако перевести на 1000001",
      `Замечаний: 24 (их показывает офис автонома перед переносом)`,
      `Контрольная сумма: ${golden.checksum}`,
    ]);
    const printed = [...out, ...err].join("\n");
    for (const secret of [
      golden.payload.badgeSalt,
      ...golden.payload.badges.map((badge) => badge.badgePhc),
      ...golden.payload.operators.map((operator) => operator.pinPhc),
      "pbkdf2$",
      "MRK-000743",
    ]) {
      assert.ok(!printed.includes(secret), "the console shows a secret");
    }

    const again = await run(["--tenant", "imp-test-atoll", "--out-dir", dir]);
    assert.equal(again.code, 1);
    assert.match(again.err.join("\n"), /EEXIST/u);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), golden);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cloud that is not clean writes no file and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const raw = JSON.parse(rawText);
    raw.activeShifts = [{ monthKey: "OCT26", seq: 7, createdFrom: "admin" }];
    raw.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }];
    const { code, out, err } = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir],
      JSON.stringify(raw),
    );
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      "Выгрузка невозможна: cloud_not_clean: the cloud has an active shift or an unsynced station",
      "  смена OCT26-007 не закрыта",
      "  станция «Станция 1» не синхронизирована после последнего закрытия смены",
    ]);
    const rehearsal = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir, "--rehearsal"],
      JSON.stringify(raw),
    );
    assert.equal(rehearsal.code, 0, rehearsal.err.join("\n"));
    assert.match(rehearsal.out[0], /ПРОБНЫЙ: не для переключения/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output that is not JSON fails without quoting it", async () => {
  const { code, err } = await run(
    ["--tenant", "imp-test-atoll"],
    '{"badgeCode": "MRK-SECRET-1" oops',
  );
  assert.equal(code, 1);
  assert.deepEqual(err, ["Выгрузка не удалась: psql did not print one JSON document"]);
});

test("an unknown argument exits with 64 before psql runs", async () => {
  const { code, calls, err } = await run(["--tenant", "t1", "--force"]);
  assert.equal(code, 64);
  assert.deepEqual(calls, []);
  assert.deepEqual(err, ["unknown argument --force"]);
});
```

Создать `tools/standalone-export/test/export-sql.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runPsql } from "../cli.mjs";

/**
 * `export.sql` against a database with the cloud's migrations applied. It
 * seeds two tenants with fixed ids (`fixtures/seed-cloud.sql`), so it runs
 * only where that is allowed: CI's `verify-api-tests` sets the variable to its
 * throwaway Postgres; locally, point it at a disposable one, never at a
 * shared or production database.
 */
const URL_VARIABLE = "STANDALONE_EXPORT_TEST_DATABASE_URL";
const databaseUrl = process.env[URL_VARIABLE];
const psql = process.env.PSQL ?? "psql";

/** libpq's environment for `url`, so no password goes on a command line. */
function pgEnv(url) {
  const parsed = new URL(url);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.slice(1),
  };
}

function psqlRun(env, args) {
  const result = spawnSync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test(
  "export.sql reads one tenant, at one snapshot, exactly as the raw fixture",
  { skip: databaseUrl ? false : `set ${URL_VARIABLE} to a disposable cloud database` },
  async () => {
    const env = pgEnv(databaseUrl);
    psqlRun(env, ["-f", fixture("cleanup-cloud.sql")]);
    psqlRun(env, ["-f", fixture("seed-cloud.sql")]);
    try {
      const clean = JSON.parse(await runPsql({ psql, tenantId: "imp-test-atoll", env }));
      assert.deepEqual(clean, JSON.parse(readFileSync(fixture("raw-cloud.json"), "utf8")));

      // The other tenant's active shift and stale station did not count;
      // the same rows of this tenant do.
      psqlRun(env, [
        "-c",
        "UPDATE shifts SET status = 'active' WHERE id = '05050000-0000-4000-8000-000000000002'",
        "-c",
        "UPDATE station_devices SET last_seen_at = NULL WHERE id = '0a0d0000-0000-4000-8000-000000000001'",
      ]);
      const dirty = JSON.parse(await runPsql({ psql, tenantId: "imp-test-atoll", env }));
      assert.deepEqual(dirty.activeShifts, [{ monthKey: "OCT26", seq: 7, createdFrom: "admin" }]);
      assert.deepEqual(dirty.staleDevices, [
        { id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" },
      ]);
      assert.equal(dirty.plannedShifts, 1);

      const missing = JSON.parse(await runPsql({ psql, tenantId: "imp-test-nobody", env }));
      assert.equal(missing.tenant, null);
      assert.equal(missing.orgProfile, null);
      assert.deepEqual(missing.products, []);
    } finally {
      psqlRun(env, ["-f", fixture("cleanup-cloud.sql")]);
    }
  },
);
```

В `tools/ci/test/affected.test.mjs` фрагмент

<!-- prettier-ignore -->
```js
test("documentation-only changes select no heavy job", () => {
```

заменить на

<!-- prettier-ignore -->
```js
test("the cloud → standalone export runs its Node tests and its SQL against the cloud schema", () => {
  for (const path of [
    "tools/standalone-export/export.sql",
    "tools/standalone-export/test/fixtures/seed-cloud.sql",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      ["verify_static", "verify_api_tests"],
      path,
    );
  }
});

test("documentation-only changes select no heavy job", () => {
```

- [ ] **Step 2: Запуск — падает**

Run: `node --test tools/standalone-export/test/cli.test.mjs tools/standalone-export/test/export-sql.test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`, `Cannot find module '…/tools/standalone-export/cli.mjs'` (оба файла).

Run: `node --test tools/ci/test/affected.test.mjs`
Expected: FAIL — `the cloud → standalone export runs its Node tests and its SQL against the cloud schema` (классификатор отдаёт полный набор заданий).

- [ ] **Step 3: Реализация и подключение к CI**

Создать `tools/standalone-export/export.sql`:

<!-- prettier-ignore -->
```sql
-- One cloud tenant as one JSON document, for the standalone import (pilot
-- spec §8.7). Run by `cli.mjs` through psql against a RESTORED COPY of the
-- cloud database: `psql -X -q -A -t -v ON_ERROR_STOP=1 -v tenant_id=<id> -f export.sql`.
-- One read-only REPEATABLE READ transaction, so every table is read at one
-- snapshot. Every query is scoped to :'tenant_id'. The output holds badge
-- codes in clear text: cli.mjs reads it from psql's stdout into memory and
-- never writes it anywhere.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH prefixes AS (
  SELECT issuer_prefix::text AS issuer_prefix FROM sscc_counters WHERE tenant_id = :'tenant_id'
  UNION
  SELECT issuer_prefix::text FROM sscc_blocks WHERE tenant_id = :'tenant_id'
),
printed AS (
  SELECT substr(sscc, 2, 9) AS issuer_prefix, substr(sscc, 1, 1)::int AS extension,
    substr(sscc, 11, 7)::bigint AS serial
  FROM boxes WHERE tenant_id = :'tenant_id' AND sscc ~ '^[0-9]{18}$'
  UNION ALL
  SELECT substr(sscc, 2, 9), substr(sscc, 1, 1)::int, substr(sscc, 11, 7)::bigint
  FROM pallets WHERE tenant_id = :'tenant_id' AND sscc ~ '^[0-9]{18}$'
),
last_close AS (
  SELECT max(closed_at) AS at FROM shifts WHERE tenant_id = :'tenant_id'
)
SELECT json_build_object(
  'formatVersion', 1,
  'tenant', (SELECT json_build_object('id', o.id, 'name', o.name)
    FROM organization o WHERE o.id = :'tenant_id'),
  'orgProfile', (SELECT json_build_object(
      'gln', p.gln, 'inn', p.inn, 'gs1Prefixes', to_json(p.gs1_prefixes), 'timeZone', p.time_zone,
      'defaultBoxTemplateId', p.default_box_label_template_id,
      'defaultPalletTemplateId', p.default_pallet_label_template_id)
    FROM org_profiles p WHERE p.tenant_id = :'tenant_id'),
  'badgeSalt', (SELECT salt FROM employee_badge_salts WHERE tenant_id = :'tenant_id'),
  'lines', coalesce((SELECT json_agg(json_build_object('id', l.id, 'name', l.name)
      ORDER BY l.created_at, l.id)
    FROM lines l WHERE l.tenant_id = :'tenant_id'), '[]'::json),
  'counterparties', coalesce((SELECT json_agg(json_build_object(
      'id', c.id, 'name', c.name, 'inn', c.inn, 'gln', c.gln,
      'gs1Prefixes', to_json(c.gs1_prefixes),
      'hasNotes', coalesce(btrim(c.notes), '') <> '') ORDER BY c.created_at, c.id)
    FROM counterparties c WHERE c.tenant_id = :'tenant_id'), '[]'::json),
  'templates', coalesce((SELECT json_agg(json_build_object(
      'id', t.id, 'name', t.name, 'purpose', t.purpose, 'enabled', t.enabled,
      'chzProductGroupCodes', to_json(t.chz_product_group_codes), 'spec', t.spec)
      ORDER BY t.created_at, t.id)
    FROM label_templates t WHERE t.tenant_id = :'tenant_id'), '[]'::json),
  'boxDefaults', coalesce((SELECT json_agg(json_build_object(
      'chzProductGroupCode', d.chz_product_group_code, 'templateId', d.template_id)
      ORDER BY d.chz_product_group_code)
    FROM org_box_label_template_defaults d WHERE d.tenant_id = :'tenant_id'), '[]'::json),
  'palletDefaults', coalesce((SELECT json_agg(json_build_object(
      'chzProductGroupCode', d.chz_product_group_code, 'templateId', d.template_id)
      ORDER BY d.chz_product_group_code)
    FROM org_pallet_label_template_defaults d WHERE d.tenant_id = :'tenant_id'), '[]'::json),
  'products', coalesce((SELECT json_agg(json_build_object(
      'id', p.id, 'gtin14', p.gtin14::text, 'name', p.name, 'printName', p.print_name,
      'chzProductGroupCode', p.chz_product_group_code, 'boxCapacity', p.box_capacity,
      'palletBoxCapacity', p.pallet_box_capacity, 'shelfLifeDays', p.shelf_life_days,
      'archived', p.archived, 'defaultLabelTemplateId', p.default_label_template_id,
      'lost', to_json(array_remove(ARRAY[
        CASE WHEN p.default_counterparty_id IS NOT NULL THEN 'defaultCounterparty' END,
        CASE WHEN p.egais_code IS NOT NULL THEN 'egaisCode' END,
        CASE WHEN p.external_ref IS NOT NULL THEN 'externalRef' END,
        CASE WHEN EXISTS (SELECT 1 FROM product_images i
          WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id) THEN 'photo' END,
        CASE WHEN p.unit_price IS NOT NULL THEN 'price' END], NULL)))
      ORDER BY p.created_at, p.id)
    FROM products p WHERE p.tenant_id = :'tenant_id'), '[]'::json),
  'operators', coalesce((SELECT json_agg(json_build_object(
      'id', oc.employee_id, 'login', oc.login, 'pinHash', oc.pin_hash,
      'credentialActive', oc.active, 'employeeStatus', e.status,
      'fullName', e.full_name, 'role', e.role) ORDER BY oc.login, oc.employee_id)
    FROM operator_credentials oc
    JOIN employees e ON e.tenant_id = oc.tenant_id AND e.id = oc.employee_id
    WHERE oc.tenant_id = :'tenant_id'), '[]'::json),
  'badges', coalesce((SELECT json_agg(json_build_object(
      'id', b.id, 'operatorId', b.employee_id, 'badgeCode', b.badge_code,
      'badgeHash', b.badge_hash, 'label', b.label) ORDER BY b.issued_at, b.id)
    FROM employee_badges b
    WHERE b.tenant_id = :'tenant_id' AND b.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM operator_credentials oc
        WHERE oc.tenant_id = b.tenant_id AND oc.employee_id = b.employee_id)), '[]'::json),
  'nonOperatorBadges', (SELECT count(*) FROM employee_badges b
    WHERE b.tenant_id = :'tenant_id' AND b.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM operator_credentials oc
        WHERE oc.tenant_id = b.tenant_id AND oc.employee_id = b.employee_id)),
  'ssccCounters', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', s.issuer_prefix::text, 'extension', s.extension_digit,
      'nextSerial', s.next_serial) ORDER BY s.issuer_prefix, s.extension_digit)
    FROM sscc_counters s WHERE s.tenant_id = :'tenant_id'), '[]'::json),
  'ssccBlocks', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', g.issuer_prefix, 'extension', g.extension_digit,
      'maxToSerial', g.max_to, 'maxConsumedThrough', g.max_consumed)
      ORDER BY g.issuer_prefix, g.extension_digit)
    FROM (SELECT issuer_prefix::text AS issuer_prefix, extension_digit,
        max(to_serial) AS max_to, max(consumed_through_serial) AS max_consumed
      FROM sscc_blocks WHERE tenant_id = :'tenant_id'
      GROUP BY issuer_prefix, extension_digit) g), '[]'::json),
  'ssccPrinted', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', g.issuer_prefix, 'extension', g.extension, 'maxSerial', g.max_serial)
      ORDER BY g.issuer_prefix, g.extension)
    FROM (SELECT issuer_prefix, extension, max(serial) AS max_serial FROM printed
      WHERE extension IN (0, 1) AND issuer_prefix IN (SELECT issuer_prefix FROM prefixes)
      GROUP BY issuer_prefix, extension) g), '[]'::json),
  'shiftNumberCounters', coalesce((SELECT json_agg(json_build_object(
      'monthKey', n.month_key, 'lastSeq', n.last_seq) ORDER BY n.month_key)
    FROM shift_number_counters n WHERE n.tenant_id = :'tenant_id'), '[]'::json),
  'activeShifts', coalesce((SELECT json_agg(json_build_object(
      'monthKey', s.number_month_key, 'seq', s.number_seq, 'createdFrom', s.created_from)
      ORDER BY s.number_month_key, s.number_seq, s.id)
    FROM shifts s WHERE s.tenant_id = :'tenant_id' AND s.status = 'active'), '[]'::json),
  'staleDevices', coalesce((SELECT json_agg(json_build_object('id', d.id, 'name', d.name)
      ORDER BY d.name, d.id)
    FROM station_devices d, last_close
    WHERE d.tenant_id = :'tenant_id' AND d.revoked_at IS NULL AND last_close.at IS NOT NULL
      AND (d.last_seen_at IS NULL OR d.last_seen_at < last_close.at)
      AND EXISTS (SELECT 1 FROM sscc_blocks b
        WHERE b.tenant_id = d.tenant_id AND b.device_id = d.id AND b.revoked_at IS NULL)), '[]'::json),
  'counterpartyIssuedShifts', (SELECT count(*) FROM shifts
    WHERE tenant_id = :'tenant_id' AND sscc_issuer_counterparty_id IS NOT NULL),
  'plannedShifts', (SELECT count(*) FROM shifts
    WHERE tenant_id = :'tenant_id' AND status = 'planned')
);

COMMIT;
```

Создать `tools/standalone-export/cli.mjs`:

<!-- prettier-ignore -->
```js
#!/usr/bin/env node
/**
 * Cloud → standalone export (pilot spec §8.7, plan IMP). Runs `export.sql`
 * through psql against a RESTORED COPY of the cloud database, builds the
 * import file and writes it next to nothing else:
 *
 *   node tools/standalone-export/cli.mjs --tenant <tenantId> [--out-dir <dir>] [--rehearsal] [--psql <path>]
 *
 * The connection comes from libpq's environment (PGHOST, PGPORT, PGUSER,
 * PGPASSWORD or ~/.pgpass, PGDATABASE, PGSSLMODE), never from an argument,
 * so no password reaches the shell history or a process list. The file
 * holds PIN and badge hashes and the badge salt: it is written owner-only
 * and never over an existing file; it travels on a flash drive and is
 * deleted after the import (docs/runbooks/standalone-cloud-cutover.md). The
 * summary on stdout names counts, numbers and the checksum, never a hash, a
 * salt or a badge code.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ExportError, buildExportFile } from "./transform.mjs";

const SQL = fileURLToPath(new URL("./export.sql", import.meta.url));
const EXTENSIONS = { 0: "короба", 1: "паллеты" };

export function parseArgs(argv) {
  const options = { tenantId: null, outDir: ".", rehearsal: false, psql: "psql" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rehearsal") options.rehearsal = true;
    else if (arg === "--tenant" || arg === "--out-dir" || arg === "--psql") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === "--tenant") options.tenantId = value;
      else if (arg === "--out-dir") options.outDir = value;
      else options.psql = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.tenantId === null || !/^[A-Za-z0-9_-]{1,64}$/u.test(options.tenantId)) {
    throw new Error("--tenant <tenantId> (letters, digits, _ and -) is required");
  }
  return options;
}

/** `export.sql`'s JSON for `tenantId`, read from psql's stdout into memory. */
export function runPsql({ psql = "psql", tenantId, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", `tenant_id=${tenantId}`, "-f", SQL],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`psql exited with ${code}`));
    });
  });
}

/**
 * psql's output as one JSON document. `JSON.parse`'s own message quotes the
 * text around the fault, and that text may hold a badge code, so a failure
 * says only that it failed.
 */
export function parseRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("psql did not print one JSON document");
  }
}

/** `markiro-cloud-export-<INN or tenant>-<date>.json`, as the pilot spec names it. */
export function fileName(file) {
  const owner = file.payload.organization.inn ?? file.source.tenantId;
  return `markiro-cloud-export-${owner}-${file.exportedAt.slice(0, 10)}.json`;
}

/** What the person running the export reads: counts and numbers, no secret. */
export function summary(file, path) {
  const { payload, cutover } = file;
  const org = payload.organization;
  const lines = [
    `Файл: ${path}${file.rehearsal ? " (ПРОБНЫЙ: не для переключения)" : ""}`,
    `Организация: ${org.name}, ИНН ${org.inn ?? "—"}, GLN ${org.gln}, часовой пояс ${org.timeZone}`,
    `Записей: линий ${payload.lines.length}, контрагентов ${payload.counterparties.length}, ` +
      `шаблонов ${payload.templates.length}, товаров ${payload.products.length}, ` +
      `операторов ${payload.operators.length}, бейджей ${payload.badges.length}`,
    `Номера смен: ${
      payload.shiftNumberCounters.map((each) => `${each.monthKey} → ${each.lastSeq}`).join(", ") ||
      "—"
    }`,
    "SSCC (префикс, расширение, владелец):",
  ];
  for (const row of cutover.ssccCounters) {
    const owner =
      row.owner.kind === "organization"
        ? "организация"
        : row.owner.kind === "counterparty"
          ? `контрагент «${row.owner.name}»`
          : "неизвестно";
    lines.push(
      `  ${row.issuerPrefix}, ${EXTENSIONS[row.extension]} (${row.extension}), ${owner}: ` +
        `выдано облаком до ${row.issuedMax ?? "—"}, напечатано до ${row.printedMax ?? "—"}, ` +
        `автоном начнёт с ${row.standaloneStart}, облако перевести на ${row.cloudReseedTo ?? "окно не помещается"}`,
    );
  }
  lines.push(`Замечаний: ${file.notes.length} (их показывает офис автонома перед переносом)`);
  lines.push(`Контрольная сумма: ${file.checksum}`);
  return lines;
}

export async function main(argv, deps = {}) {
  const {
    run = runPsql,
    now = () => new Date(),
    stdout = (line) => process.stdout.write(`${line}\n`),
    stderr = (line) => process.stderr.write(`${line}\n`),
    writeFile = (path, text) => writeFileSync(path, text, { flag: "wx", mode: 0o600 }),
    env = process.env,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(error.message);
    return 64;
  }
  try {
    const raw = parseRaw(await run({ psql: options.psql, tenantId: options.tenantId, env }));
    const file = buildExportFile(raw, {
      exportedAt: now().toISOString(),
      rehearsal: options.rehearsal,
    });
    const path = join(options.outDir, fileName(file));
    writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
    for (const line of summary(file, path)) stdout(line);
    return 0;
  } catch (error) {
    if (error instanceof ExportError) {
      stderr(`Выгрузка невозможна: ${error.code}: ${error.message}`);
      for (const blocker of error.blockers ?? []) {
        stderr(
          blocker.code === "active_shift"
            ? `  смена ${blocker.number} не закрыта`
            : `  станция «${blocker.name}» не синхронизирована после последнего закрытия смены`,
        );
      }
      return 2;
    }
    stderr(`Выгрузка не удалась: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
```

В `package.json` фрагмент

<!-- prettier-ignore -->
```json
    "test:rospatent": "node --test tools/rospatent/test/*.test.mjs"
```

заменить на

<!-- prettier-ignore -->
```json
    "test:rospatent": "node --test tools/rospatent/test/*.test.mjs",
    "test:standalone-export": "node --test tools/standalone-export/test/*.test.mjs"
```

В `.github/workflows/ci.yml` фрагмент

<!-- prettier-ignore -->
```yaml
      - run: pnpm test:rospatent
      - run: pnpm test:handheld-release:contract
```

заменить на

<!-- prettier-ignore -->
```yaml
      - run: pnpm test:rospatent
      # The cloud → standalone export (plan IMP): pure tests here; its SQL
      # test skips without a database and runs in verify-api-tests.
      - run: pnpm test:standalone-export
      - run: pnpm test:handheld-release:contract
```

В `.github/workflows/ci.yml` фрагмент

<!-- prettier-ignore -->
```yaml
      - run: pnpm --filter @markiro/db db:migrate
      # `api#test` already declares `dependsOn: @markiro/db#test`, so the two
```

заменить на

<!-- prettier-ignore -->
```yaml
      - run: pnpm --filter @markiro/db db:migrate
      # export.sql of the cloud → standalone export against the migrated
      # cloud schema; it seeds and removes two tenants of its own.
      - run: pnpm test:standalone-export
        env:
          STANDALONE_EXPORT_TEST_DATABASE_URL: postgres://markiro:markiro@localhost:5432/markiro
      # `api#test` already declares `dependsOn: @markiro/db#test`, so the two
```

В `tools/ci/affected.mjs` фрагмент

<!-- prettier-ignore -->
```js
  if (path.startsWith("tools/handheld-release/")) return ["verify_static"];
```

заменить на

<!-- prettier-ignore -->
```js
  if (path.startsWith("tools/handheld-release/")) return ["verify_static"];
  // The cloud → standalone export (plan IMP): its pure tests run in the Node
  // job, its SQL against the migrated cloud schema in the API job.
  if (path.startsWith("tools/standalone-export/")) return ["verify_static", "verify_api_tests"];
```

- [ ] **Step 4: Запуск — проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false test:standalone-export`
Expected: `ℹ tests 28`, `ℹ pass 27`, `ℹ skipped 1` (тест SQL без базы: `set STANDALONE_EXPORT_TEST_DATABASE_URL to a disposable cloud database`).

Run (вне песочницы, Postgres из «Заметок для исполнения»): `STANDALONE_EXPORT_TEST_DATABASE_URL=postgres://markiro:markiro@127.0.0.1:55611/markiro node --test tools/standalone-export/test/export-sql.test.mjs`
Expected: `ℹ tests 1`, `ℹ pass 1`.

Run (вне песочницы): `node --test tools/ci/test/*.test.mjs`
Expected: `ℹ tests 48`, `ℹ pass 48`.

- [ ] **Step 5: Мутации**

Для мутаций `export.sql` — команда теста SQL вне песочницы, как в шаге 4:

1. В запросе `'badges'` (не `'nonOperatorBadges'`) `WHERE b.tenant_id = :'tenant_id' AND b.revoked_at IS NULL` → `WHERE b.tenant_id = :'tenant_id'` — FAIL `export.sql reads one tenant, at one snapshot, exactly as the raw fixture` (в вывод попадает отозванный бейдж `MRK-000700`).
2. В запросе `'ssccPrinted'` `WHERE extension IN (0, 1) AND issuer_prefix IN (SELECT issuer_prefix FROM prefixes)` → `WHERE extension IN (0, 1)` — FAIL тот же тест (появляется чужой префикс `460999900`).
3. В запросе `'ssccBlocks'` `FROM sscc_blocks WHERE tenant_id = :'tenant_id'` → `FROM sscc_blocks` — FAIL тот же тест (блок второго арендатора, 900000).
4. В `cli.mjs` `const raw = parseRaw(await run(` → `const raw = JSON.parse(await run(` — FAIL `output that is not JSON fails without quoting it` (сообщение цитирует `MRK-SECRET-1`).

- [ ] **Step 6: Коммит**

```bash
docker rm -f markiro-imp-pg
node_modules/.bin/prettier --check tools/standalone-export package.json .github/workflows/ci.yml tools/ci
git diff --check
git add tools/standalone-export/export.sql tools/standalone-export/cli.mjs \
  tools/standalone-export/test/cli.test.mjs tools/standalone-export/test/export-sql.test.mjs \
  tools/standalone-export/test/fixtures/seed-cloud.sql tools/standalone-export/test/fixtures/cleanup-cloud.sql \
  package.json .github/workflows/ci.yml tools/ci/affected.mjs tools/ci/test/affected.test.mjs
git commit -m "feat(standalone): cloud export: export.sql against a restored copy, the CLI and its CI jobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `proto` — запрос и ответ импорта по эталонному файлу

Типы маршрута — в новом модуле `proto/src/cloud_import.rs` (одна строка в `lib.rs`, чтобы не спорить с правками протокола других потоков). Запрос и все вложенные структуры отвергают незнакомые поля (`deny_unknown_fields`), ответ их терпит. Хеши и соль — `Secret`: `{:?}` запроса их не печатает. Запрос в тестах собирается из эталонного файла по одному правилу — `{ importId, dryRun, formatVersion, exportedAt, rehearsal, source, payload }` — его же повторяют построитель офиса (задача 7) и помощник тестов хоста (задача 5); отдельной фикстуры запроса нет, чтобы не держать вторую копию 400 строк. Ответ — фикстура `cloud-import-summary.json`, ровно то, что хост отвечает на эталонный файл после мастера `support::app::admin` (задача 6 это проверяет).

**Files:**

- Create: `apps/standalone/proto/src/cloud_import.rs`, `apps/standalone/proto/fixtures/cloud-import-summary.json`
- Modify: `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/proto/tests/cloud_import.rs` (Create)

**Interfaces:**

- Consumes: `Secret`, `TemplatePurpose`, `CategoryTemplateDefaultInput` (`proto/src/lib.rs`); эталонный файл (задача 2).
- Produces (`markiro_proto::cloud_import`): `CLOUD_IMPORT_FORMAT_VERSION: u32 = 1`; `CloudImportRequest { import_id, dry_run, format_version, exported_at, rehearsal, source: CloudImportSource { tenant_id, tenant_name }, payload: CloudImportPayload }`; `CloudImportPayload { organization: CloudOrganization, badge_salt: Option<Secret>, lines: Vec<CloudLine>, counterparties: Vec<CloudCounterparty>, templates: Vec<CloudTemplate>, template_defaults: CloudTemplateDefaults, products: Vec<CloudProduct>, operators: Vec<CloudOperator>, badges: Vec<CloudBadge>, sscc_counters: Vec<CloudSsccCounter>, shift_number_counters: Vec<CloudShiftNumberCounter> }`; `CloudImportSummary { dry_run, repeated, lines_created, lines_present, counterparties, templates, org_defaults, category_defaults, products, operators, badges, badge_salt_replaced, sscc_counters: Vec<SsccCounterValue>, shift_number_counters: Vec<ShiftNumberCounterValue> }`.

- [ ] **Step 1: Фикстура ответа и тест (падающий)**

Создать `apps/standalone/proto/fixtures/cloud-import-summary.json`:

<!-- prettier-ignore -->
```json
{
  "dryRun": false,
  "repeated": false,
  "linesCreated": 2,
  "linesPresent": 1,
  "counterparties": 2,
  "templates": 5,
  "orgDefaults": 2,
  "categoryDefaults": 2,
  "products": 3,
  "operators": 3,
  "badges": 3,
  "badgeSaltReplaced": true,
  "ssccCounters": [
    { "issuerPrefix": "460068200", "extension": 0, "nextSerial": 30000 },
    { "issuerPrefix": "460068200", "extension": 1, "nextSerial": 10000 },
    { "issuerPrefix": "460123400", "extension": 0, "nextSerial": 1 }
  ],
  "shiftNumberCounters": [
    { "monthKey": "NOV26", "lastSeq": 1 },
    { "monthKey": "OCT26", "lastSeq": 7 },
    { "monthKey": "SEP26", "lastSeq": 41 }
  ]
}
```

Создать `apps/standalone/proto/tests/cloud_import.rs`:

<!-- prettier-ignore -->
```rust
//! The import's wire types (plan IMP) against the export tool's golden file
//! `cloud-export-file.json`: the request the office builds from it is
//! `{ importId, dryRun, formatVersion, exportedAt, rehearsal, source, payload }`
//! (`cloudImportRequest` in `src/host/cloud-import.ts`), and the host's answer
//! to it on a new site is `cloud-import-summary.json`.

use markiro_proto::cloud_import::{
    CloudImportRequest, CloudImportSummary, CLOUD_IMPORT_FORMAT_VERSION,
};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// The request the office sends for the golden file.
fn request() -> Value {
    let file = fixture("cloud-export-file.json");
    json!({
        "importId": "8f14e45f-ceea-467a-9d9b-1c7e0b1a2d3e",
        "dryRun": false,
        "formatVersion": file["formatVersion"],
        "exportedAt": file["exportedAt"],
        "rehearsal": file["rehearsal"],
        "source": file["source"],
        "payload": file["payload"],
    })
}

#[test]
fn the_request_of_the_golden_file_round_trips() {
    let original = request();
    let typed: CloudImportRequest = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), original);
    assert_eq!(typed.format_version, CLOUD_IMPORT_FORMAT_VERSION);
    let payload = &typed.payload;
    assert_eq!(
        (
            payload.lines.len(),
            payload.counterparties.len(),
            payload.templates.len(),
            payload.products.len(),
            payload.operators.len(),
            payload.badges.len(),
            payload.sscc_counters.len(),
            payload.shift_number_counters.len(),
        ),
        (3, 2, 5, 3, 3, 3, 3, 3)
    );
}

#[test]
fn the_summary_fixture_round_trips_and_tolerates_new_fields() {
    let original = fixture("cloud-import-summary.json");
    let typed: CloudImportSummary = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), original);
    let mut newer = original;
    newer["warnings"] = json!([]);
    newer["ssccCounters"][0]["owner"] = json!("organization");
    let read: CloudImportSummary = serde_json::from_value(newer).unwrap();
    assert_eq!(read, typed);
}

#[test]
fn the_request_refuses_a_field_it_does_not_know_at_every_level() {
    for pointer in [
        "",
        "/source",
        "/payload",
        "/payload/organization",
        "/payload/lines/0",
        "/payload/counterparties/0",
        "/payload/templates/0",
        "/payload/templateDefaults",
        "/payload/templateDefaults/categories/0",
        "/payload/products/0",
        "/payload/operators/0",
        "/payload/badges/0",
        "/payload/ssccCounters/0",
        "/payload/shiftNumberCounters/0",
    ] {
        let mut body = request();
        body.pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("{pointer} is an object"))
            .insert("unitPrice".to_owned(), json!("89.90"));
        assert!(
            serde_json::from_value::<CloudImportRequest>(body).is_err(),
            "{pointer} took an unknown field"
        );
    }
}

/// The hashes and the salt are `Secret`s: a stray `{:?}` prints none.
#[test]
fn a_debug_print_of_the_request_holds_no_hash_and_no_salt() {
    let typed: CloudImportRequest = serde_json::from_value(request()).unwrap();
    let printed = format!("{typed:?}");
    assert!(!printed.contains("pbkdf2$"), "{printed}");
    assert!(!printed.contains("bWFya2lyby1iYWRnZS0wMQ=="));
    assert!(printed.contains("Secret(***)"));
}
```

- [ ] **Step 2: Запуск — падает**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked --test cloud_import`
Expected: FAIL — `error[E0432]: unresolved import \`markiro_proto::cloud_import\``.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/proto/src/cloud_import.rs`:

<!-- prettier-ignore -->
```rust
//! `POST /v1/office/import`: the cloud's data moved into a new site (plan
//! IMP, pilot spec §8). The export tool (`tools/standalone-export`) writes a
//! file whose `payload` is [`CloudImportPayload`] exactly; the office checks
//! the file's checksum and sends this request. The fixture
//! `cloud-import-request.json` is what the office builds from
//! `cloud-export-file.json`, which the tool builds from its raw fixture, so
//! the three cannot drift apart.
//!
//! The request carries PIN and badge hashes and the badge salt as
//! [`Secret`]s: a `{:?}` of it prints none of them.

use serde::{Deserialize, Serialize};

use crate::{CategoryTemplateDefaultInput, Secret, TemplatePurpose};

/// The import file's `formatVersion` this build reads.
pub const CLOUD_IMPORT_FORMAT_VERSION: u32 = 1;

/// The import, or its trial (`dryRun`: every check and every write, then a
/// rollback). `importId`, a lower-case hyphenated UUID the office makes up
/// once per file, makes it repeatable: the same id after a lost answer gets
/// the stored summary back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImportRequest {
    pub import_id: String,
    pub dry_run: bool,
    pub format_version: u32,
    /// When the tool read the cloud (RFC 3339), for the audit row.
    pub exported_at: String,
    /// A rehearsal file (made while the cloud was not clean): the audit
    /// row says so.
    pub rehearsal: bool,
    pub source: CloudImportSource,
    pub payload: CloudImportPayload,
}

/// Which cloud tenant the file came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImportSource {
    pub tenant_id: String,
    pub tenant_name: String,
}

/// Everything that moves (pilot spec §8.2). Ids are the cloud's UUIDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImportPayload {
    /// The site's organization must have this GLN; nothing else of it is
    /// written (the wizard and «Организация» own the profile).
    pub organization: CloudOrganization,
    /// The tenant's badge salt (16 bytes, standard base64 with padding): it
    /// becomes the site's, so the badges' hashes move as they are (§8.3).
    pub badge_salt: Option<Secret>,
    pub lines: Vec<CloudLine>,
    pub counterparties: Vec<CloudCounterparty>,
    pub templates: Vec<CloudTemplate>,
    pub template_defaults: CloudTemplateDefaults,
    pub products: Vec<CloudProduct>,
    pub operators: Vec<CloudOperator>,
    pub badges: Vec<CloudBadge>,
    /// Where the standalone's counters start (forward only).
    pub sscc_counters: Vec<CloudSsccCounter>,
    /// The cloud's last shift number of each month (forward only).
    pub shift_number_counters: Vec<CloudShiftNumberCounter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudOrganization {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudLine {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudCounterparty {
    pub id: String,
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudTemplate {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    pub chz_product_group_codes: Option<Vec<u32>>,
    pub spec: serde_json::Value,
}

/// The organization's box and pallet defaults (`null` keeps the wizard's)
/// and the category defaults; the cloud has no product-duplicate default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudTemplateDefaults {
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub categories: Vec<CategoryTemplateDefaultInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudProduct {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
}

/// An operator with the cloud's PIN hash, byte for byte (§8.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudOperator {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    pub pin_phc: Secret,
    pub active: bool,
}

/// A badge in use, hashed under [`CloudImportPayload::badge_salt`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudBadge {
    pub id: String,
    pub operator_id: String,
    pub badge_phc: Secret,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudSsccCounter {
    pub issuer_prefix: String,
    pub extension: u8,
    pub next_serial: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudShiftNumberCounter {
    pub month_key: String,
    pub last_seq: u32,
}

/// The answer: what the import wrote (or, for `dryRun`, would write), and
/// the counters as they stand after it. `repeated` is a repeat of an import
/// already done, answered from its audit row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudImportSummary {
    pub dry_run: bool,
    pub repeated: bool,
    pub lines_created: u32,
    /// File lines whose name an active line of the site already has (the
    /// wizard's): kept as they are, not created again.
    pub lines_present: u32,
    pub counterparties: u32,
    pub templates: u32,
    /// How many of the organization's two defaults the file set.
    pub org_defaults: u32,
    pub category_defaults: u32,
    pub products: u32,
    pub operators: u32,
    pub badges: u32,
    /// The site's badge salt became the file's.
    pub badge_salt_replaced: bool,
    pub sscc_counters: Vec<SsccCounterValue>,
    pub shift_number_counters: Vec<ShiftNumberCounterValue>,
}

/// A counter of the file as it stands after the import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccCounterValue {
    pub issuer_prefix: String,
    pub extension: u8,
    pub next_serial: u64,
}

/// A month of the file as its counter stands after the import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftNumberCounterValue {
    pub month_key: String,
    pub last_seq: u32,
}
```

В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod pairing;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod cloud_import;
pub mod pairing;
```

- [ ] **Step 4: Запуск — проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked --test cloud_import`
Expected: `test result: ok. 4 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: все наборы `ok` (прежние фикстуры не задеты).

- [ ] **Step 5: Мутации**

1. У `CloudBadge` убрать `deny_unknown_fields` из `#[serde(rename_all = "camelCase", deny_unknown_fields)]` — FAIL `the_request_refuses_a_field_it_does_not_know_at_every_level` (`/payload/badges/0 took an unknown field`).
2. У `CloudOperator` `pub pin_phc: Secret,` → `pub pin_phc: String,` — FAIL `a_debug_print_of_the_request_holds_no_hash_and_no_salt`.

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --check apps/standalone/proto/fixtures/cloud-import-summary.json
git diff --check
git add apps/standalone/proto/src/cloud_import.rs apps/standalone/proto/src/lib.rs \
  apps/standalone/proto/tests/cloud_import.rs apps/standalone/proto/fixtures/cloud-import-summary.json
git commit -m "feat(standalone): import request and summary types against the export tool's golden file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Хост — проверки строк файла без базы (`host/src/cloud_import.rs`)

`cloud_import::check` проверяет каждую строку так, как её проверяет обычный маршрут офиса (`validate.rs`: имена, ИНН, GLN, префиксы GS1, GTIN, вместимости, срок, табельный номер, PIN-хеш, хеш бейджа с 100 000 итераций и солью файла, макет до 256 КБ и 64 уровней, категории), и добавляет то, что видно только в файле целиком: повтор id в списке, повтор имени линии без учёта регистра, повтор GTIN среди действующих товаров (архивный может делить GTIN), повтор табельного номера, бейджа, счётчика, месяца; ссылку бейджа на оператора файла, предпочтения товара — на шаблон файла того же назначения, умолчания — на шаблон файла, который подходит слоту (`templates::fits`). Ошибка — `validation_failed` с путём запроса. Существование групп ЧЗ проверяет маршрут одним чтением: `check` собирает их в `group_refs`. `validate::clean_text` становится публичной (одно слово), чтобы `source` проверялся тем же правилом текста. Помощник `cloud_import_request` в `tests/support/app.rs` собирает запрос из эталонного файла — им пользуются наборы задач 5 и 6.

**Files:**

- Create: `apps/standalone/host/src/cloud_import.rs`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/validate.rs`, `apps/standalone/host/tests/support/app.rs`
- Test: `apps/standalone/host/tests/cloud_import_rules.rs` (Create)

**Interfaces:**

- Consumes: `CloudImportRequest`, `CLOUD_IMPORT_FORMAT_VERSION` (задача 4); `validate::*`, `templates::{fits, Scope}`.
- Produces:
  - `pub fn markiro_host::cloud_import::check(request: &CloudImportRequest) -> Result<ValidImport, ApiError>`;
  - `pub struct ValidImport { gln, badge_salt: Option<Vec<u8>>, lines: Vec<Line>, counterparties: Vec<Counterparty>, templates: Vec<Template>, default_box_template_id, default_pallet_template_id, categories: Vec<CategoryDefault>, products: Vec<Product>, operators: Vec<Operator>, badges: Vec<Badge>, sscc_counters: Vec<SsccCounter>, shift_number_counters: Vec<ShiftNumberCounter>, group_refs: Vec<(String, u32)> }` (поля структур — в коде шага 3);
  - `pub fn validate::clean_text<'a>(field, text: &'a str, max, what) -> Result<&'a str, ApiError>`;
  - в `tests/support/app.rs`: `pub const IMPORT_ID: &str`, `pub fn cloud_import_request(import_id: &str, dry_run: bool) -> Value`.

- [ ] **Step 1: Помощник и тест (падающий)**

В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let (status, shift) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}
```

заменить на

<!-- prettier-ignore -->
```rust
    let (status, shift) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}

/// The `importId` the tests send with the golden file.
pub const IMPORT_ID: &str = "8f14e45f-ceea-467a-9d9b-1c7e0b1a2d3e";

/// The request the office sends for the export tool's golden file
/// (`proto/fixtures/cloud-export-file.json`, plan IMP): the file's envelope
/// and payload under `import_id` (`cloudImportRequest` in the webview).
pub fn cloud_import_request(import_id: &str, dry_run: bool) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../proto/fixtures/cloud-export-file.json"
    );
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    serde_json::json!({
        "importId": import_id,
        "dryRun": dry_run,
        "formatVersion": file["formatVersion"],
        "exportedAt": file["exportedAt"],
        "rehearsal": file["rehearsal"],
        "source": file["source"],
        "payload": file["payload"],
    })
}
```

Создать `apps/standalone/host/tests/cloud_import_rules.rs`:

<!-- prettier-ignore -->
```rust
//! The import's checks that need no database (`markiro_host::cloud_import`,
//! plan IMP): the golden file passes, and each rule refuses its row with the
//! request's JSON path. Every case changes one value of the golden request.

mod support;

use markiro_host::cloud_import::check;
use markiro_proto::cloud_import::CloudImportRequest;
use serde_json::{json, Value};
use support::app::{cloud_import_request, IMPORT_ID};

fn request() -> Value {
    cloud_import_request(IMPORT_ID, false)
}

fn typed(body: Value) -> CloudImportRequest {
    serde_json::from_value(body).unwrap()
}

/// The `details.field` of the refusal of the golden request after `change`.
fn refused(change: impl FnOnce(&mut Value)) -> String {
    let mut body = request();
    change(&mut body);
    let error = match check(&typed(body)) {
        Ok(_) => panic!("the change was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "validation_failed", "{}", error.message());
    error.details().unwrap()["field"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The PIN 4821 under 10 000 iterations: a PIN hash the host takes.
const PIN_10000: &str =
    "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=";

#[test]
fn the_golden_file_passes_whole() {
    let valid = check(&typed(request())).unwrap();
    assert_eq!(valid.gln, "4600682000010");
    assert_eq!(valid.badge_salt.as_deref(), Some(&b"markiro-badge-01"[..]));
    assert_eq!(
        valid
            .lines
            .iter()
            .map(|line| (line.name.as_str(), line.name_key.as_str()))
            .collect::<Vec<_>>(),
        [
            ("Линия 1", "линия 1"),
            ("Упаковка", "упаковка"),
            ("линия 1 (2)", "линия 1 (2)")
        ]
    );
    assert_eq!(
        (
            valid.counterparties.len(),
            valid.templates.len(),
            valid.categories.len(),
            valid.products.len(),
            valid.operators.len(),
            valid.badges.len(),
            valid.sscc_counters.len(),
            valid.shift_number_counters.len(),
        ),
        (2, 5, 2, 3, 3, 3, 3, 3)
    );
    // The archived product keeps the GTIN of a product in use.
    assert_eq!(valid.products[0].gtin14, valid.products[2].gtin14);
    assert!(valid.products[2].archived);
    assert_eq!(
        valid.group_refs,
        [
            ("payload.templates.1.chzProductGroupCodes".to_owned(), 8),
            (
                "payload.templateDefaults.categories.0.chzProductGroupCode".to_owned(),
                8
            ),
            (
                "payload.templateDefaults.categories.1.chzProductGroupCode".to_owned(),
                8
            ),
            ("payload.products.0.chzProductGroupCode".to_owned(), 8),
            ("payload.products.1.chzProductGroupCode".to_owned(), 13),
            ("payload.products.2.chzProductGroupCode".to_owned(), 8),
        ]
    );
}

#[test]
fn the_envelope_is_checked() {
    assert_eq!(
        refused(|body| body["importId"] = json!("8F14E45F-CEEA-467A-9D9B-1C7E0B1A2D3E")),
        "importId"
    );
    assert_eq!(
        refused(|body| body["formatVersion"] = json!(2)),
        "formatVersion"
    );
    assert_eq!(
        refused(|body| body["exportedAt"] = json!("9 октября")),
        "exportedAt"
    );
    assert_eq!(
        refused(|body| body["source"]["tenantName"] = json!("\u{0}")),
        "source.tenantName"
    );
    assert_eq!(
        refused(|body| body["payload"]["organization"]["gln"] = json!("460068200001")),
        "payload.organization.gln"
    );
    assert_eq!(
        refused(|body| body["payload"]["badgeSalt"] = json!("bWFya2lyby1iYWRnZS0wMQ")),
        "payload.badgeSalt"
    );
    assert_eq!(
        refused(|body| body["payload"]["badgeSalt"] = json!("bWFya2lyby1iYWRnZS0w")),
        "payload.badgeSalt"
    );
}

#[test]
fn lines_counterparties_and_templates_are_checked_row_by_row() {
    assert_eq!(
        refused(|body| body["payload"]["lines"][2]["name"] = json!(" УПАКОВКА ")),
        "payload.lines.2.name"
    );
    assert_eq!(
        refused(
            |body| body["payload"]["lines"][1]["id"] = body["payload"]["lines"][0]["id"].clone()
        ),
        "payload.lines.1.id"
    );
    assert_eq!(
        refused(|body| body["payload"]["lines"][0]["id"] = json!("line-1")),
        "payload.lines.0.id"
    );
    assert_eq!(
        refused(|body| body["payload"]["counterparties"][1]["gln"] = json!("46070000000")),
        "payload.counterparties.1.gln"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][0]["spec"] = json!([])),
        "payload.templates.0.spec"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][1]["chzProductGroupCodes"] = json!([])),
        "payload.templates.1.chzProductGroupCodes"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][3]["name"] = json!(" ")),
        "payload.templates.3.name"
    );
}

#[test]
fn a_default_names_a_template_of_the_file_that_fits_its_slot() {
    let t1 = "0d0d0000-0000-4000-8000-000000000001";
    let t2 = "0d0d0000-0000-4000-8000-000000000002";
    let t5 = "0d0d0000-0000-4000-8000-000000000005";
    let default = |name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["templateDefaults"][name] = value
    };
    let category = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| {
            body["payload"]["templateDefaults"]["categories"][index][name] = value
        }
    };
    // T2 covers category 8 only, so it is no organization default.
    assert_eq!(
        refused(default("defaultBoxTemplateId", json!(t2))),
        "payload.templateDefaults.defaultBoxTemplateId"
    );
    assert_eq!(
        refused(default("defaultPalletTemplateId", json!(t1))),
        "payload.templateDefaults.defaultPalletTemplateId"
    );
    assert_eq!(
        refused(default(
            "defaultBoxTemplateId",
            json!("0d0d0000-0000-4000-8000-0000000000ff")
        )),
        "payload.templateDefaults.defaultBoxTemplateId"
    );
    // T5 is disabled; T2 does not cover category 13.
    assert_eq!(
        refused(category(0, "templateId", json!(t5))),
        "payload.templateDefaults.categories.0.templateId"
    );
    assert_eq!(
        refused(category(0, "chzProductGroupCode", json!(13))),
        "payload.templateDefaults.categories.0.templateId"
    );
    assert_eq!(
        refused(|body| {
            let second = &mut body["payload"]["templateDefaults"]["categories"][1];
            second["purpose"] = json!("box");
            second["templateId"] = json!(t2);
        }),
        "payload.templateDefaults.categories.1"
    );
}

#[test]
fn products_are_checked_up_to_the_hosts_bounds() {
    let product = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["products"][index][name] = value
    };
    assert_eq!(
        refused(|body| body["payload"]["products"][1]["gtin14"] = json!("04600682000013")),
        "payload.products.1.gtin14"
    );
    assert_eq!(
        refused(product(0, "gtin14", json!("4600682000013"))),
        "payload.products.0.gtin14"
    );
    assert_eq!(
        refused(product(0, "boxCapacity", json!(100_001))),
        "payload.products.0.boxCapacity"
    );
    assert_eq!(
        refused(product(0, "palletBoxCapacity", json!(10_001))),
        "payload.products.0.palletBoxCapacity"
    );
    assert_eq!(
        refused(product(0, "shelfLifeDays", json!(3_651))),
        "payload.products.0.shelfLifeDays"
    );
    assert_eq!(
        refused(product(0, "boxCapacity", json!(0))),
        "payload.products.0.boxCapacity"
    );
    // A pallet template, a product duplicate's and an unknown one are no box preference.
    for id in [
        "0d0d0000-0000-4000-8000-000000000003",
        "0d0d0000-0000-4000-8000-000000000004",
        "0d0d0000-0000-4000-8000-0000000000ff",
    ] {
        assert_eq!(
            refused(product(0, "defaultBoxTemplateId", json!(id))),
            "payload.products.0.defaultBoxTemplateId"
        );
    }
    assert_eq!(
        refused(product(
            1,
            "defaultPalletTemplateId",
            json!("0d0d0000-0000-4000-8000-000000000001")
        )),
        "payload.products.1.defaultPalletTemplateId"
    );
    let mut bounds = request();
    let first = &mut bounds["payload"]["products"][0];
    first["boxCapacity"] = json!(100_000);
    first["palletBoxCapacity"] = json!(10_000);
    first["shelfLifeDays"] = json!(3_650);
    assert!(check(&typed(bounds)).is_ok());
}

#[test]
fn operators_keep_their_hash_and_a_number_once() {
    let operator = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["operators"][index][name] = value
    };
    assert_eq!(
        refused(operator(0, "login", json!("12"))),
        "payload.operators.0.login"
    );
    assert_eq!(
        refused(operator(1, "login", json!("0042"))),
        "payload.operators.1.login"
    );
    assert_eq!(
        refused(operator(0, "pinPhc", json!(
            "pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
        ))),
        "payload.operators.0.pinPhc"
    );
    assert_eq!(
        refused(operator(0, "name", json!("\t"))),
        "payload.operators.0.name"
    );
    let mut lower = request();
    lower["payload"]["operators"][0]["pinPhc"] = json!(PIN_10000);
    assert!(check(&typed(lower)).is_ok());
}

#[test]
fn badges_carry_the_files_salt_and_the_domains_count() {
    let badge = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["badges"][index][name] = value
    };
    assert_eq!(
        refused(badge(
            0,
            "operatorId",
            json!("0f0f0000-0000-4000-8000-000000000003")
        )),
        "payload.badges.0.operatorId"
    );
    // A PIN hash: another salt, then the right salt with 10 000 iterations.
    assert_eq!(
        refused(badge(0, "badgePhc", json!(PIN_10000))),
        "payload.badges.0.badgePhc"
    );
    assert_eq!(
        refused(badge(
            0,
            "badgePhc",
            json!("pbkdf2$sha256$10000$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo=")
        )),
        "payload.badges.0.badgePhc"
    );
    assert_eq!(
        refused(|body| body["payload"]["badges"][2]["badgePhc"] =
            body["payload"]["badges"][0]["badgePhc"].clone()),
        "payload.badges.2.badgePhc"
    );
    assert_eq!(
        refused(|body| body["payload"]["badgeSalt"] = Value::Null),
        "payload.badgeSalt"
    );
    let mut none = request();
    none["payload"]["badges"] = json!([]);
    none["payload"]["badgeSalt"] = Value::Null;
    assert!(check(&typed(none)).is_ok());
}

#[test]
fn counters_are_checked_against_the_prefixs_serials() {
    let counter = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["ssccCounters"][index][name] = value
    };
    assert_eq!(
        refused(counter(0, "extension", json!(2))),
        "payload.ssccCounters.0.extension"
    );
    assert_eq!(
        refused(counter(0, "issuerPrefix", json!("46006820a"))),
        "payload.ssccCounters.0.issuerPrefix"
    );
    assert_eq!(
        refused(counter(0, "nextSerial", json!(10_000_000))),
        "payload.ssccCounters.0.nextSerial"
    );
    assert_eq!(
        refused(counter(0, "nextSerial", json!(0))),
        "payload.ssccCounters.0.nextSerial"
    );
    assert_eq!(
        refused(|body| body["payload"]["ssccCounters"][2]["issuerPrefix"] = json!("460068200")),
        "payload.ssccCounters.2"
    );
    let mut edges = request();
    edges["payload"]["ssccCounters"][0]["nextSerial"] = json!(9_999_999);
    edges["payload"]["ssccCounters"][1]["nextSerial"] = json!(0);
    assert!(check(&typed(edges)).is_ok());

    let month = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["shiftNumberCounters"][index][name] = value
    };
    for key in ["Oct26", "OCT2", "OCT266", "XYZ26", "OCT2a"] {
        assert_eq!(
            refused(month(0, "monthKey", json!(key))),
            "payload.shiftNumberCounters.0.monthKey",
            "{key}"
        );
    }
    assert_eq!(
        refused(month(0, "lastSeq", json!(0))),
        "payload.shiftNumberCounters.0.lastSeq"
    );
    assert_eq!(
        refused(month(1, "monthKey", json!("NOV26"))),
        "payload.shiftNumberCounters.1.monthKey"
    );
}
```

- [ ] **Step 2: Запуск — падает**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --locked --test cloud_import_rules`
Expected: FAIL — `error[E0432]: unresolved import \`markiro_host::cloud_import\``.

- [ ] **Step 3: Реализация**

В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod clock;
pub mod config;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod clock;
pub mod cloud_import;
pub mod config;
```

В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
fn clean_text<'a>(field: &str, text: &'a str, max: usize, what: &str) -> Result<&'a str, ApiError> {
```

заменить на

<!-- prettier-ignore -->
```rust
pub fn clean_text<'a>(
    field: &str,
    text: &'a str,
    max: usize,
    what: &str,
) -> Result<&'a str, ApiError> {
```

Создать `apps/standalone/host/src/cloud_import.rs`:

<!-- prettier-ignore -->
```rust
//! The import's rules that need no database (plan IMP, pilot spec §8.7):
//! every row of the file checked as the office routes check one, with the
//! request's JSON path as `details.field` (`payload.products.2.gtin14`).
//! The export tool already wrote every value the way these rules want it,
//! so a refusal means a damaged file or a bug, and the whole import is
//! refused (`routes/cloud_import.rs`). What needs the database — the site
//! is empty, its GLN, the product groups — is the route's.

use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::cloud_import::{CloudImportRequest, CLOUD_IMPORT_FORMAT_VERSION};
use markiro_proto::{OrgProfileInput, TemplatePurpose};

use crate::error::ApiError;
use crate::templates::{fits, Scope};
use crate::validate;

pub struct Line {
    pub id: String,
    pub name: String,
    pub name_key: String,
}

pub struct Counterparty {
    pub id: String,
    pub company: validate::ValidCompany,
}

pub struct Template {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    pub codes: Option<Vec<u32>>,
    /// The layout as the host stores it (`validate::template_spec`).
    pub spec: String,
}

pub struct CategoryDefault {
    pub code: u32,
    pub purpose: TemplatePurpose,
    pub template_id: String,
}

pub struct Product {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub group: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
}

pub struct Operator {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    pub pin_phc: String,
    pub active: bool,
}

pub struct Badge {
    pub id: String,
    pub operator_id: String,
    pub badge_phc: String,
    pub label: Option<String>,
}

pub struct SsccCounter {
    pub issuer_prefix: String,
    pub extension: u8,
    pub next_serial: u64,
}

pub struct ShiftNumberCounter {
    pub month_key: String,
    pub last_seq: u32,
}

/// The file after the checks, ready to write.
pub struct ValidImport {
    pub gln: String,
    pub badge_salt: Option<Vec<u8>>,
    pub lines: Vec<Line>,
    pub counterparties: Vec<Counterparty>,
    pub templates: Vec<Template>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub categories: Vec<CategoryDefault>,
    pub products: Vec<Product>,
    pub operators: Vec<Operator>,
    pub badges: Vec<Badge>,
    pub sscc_counters: Vec<SsccCounter>,
    pub shift_number_counters: Vec<ShiftNumberCounter>,
    /// Every product-group code a row names, with the row's field: the
    /// route checks them against `chz_product_groups` in one read.
    pub group_refs: Vec<(String, u32)>,
}

const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// A shift-number counter's key: `MONYY`, as `shifts::month_key` writes it.
fn is_month_key(text: &str) -> bool {
    text.len() == 5
        && MONTHS.contains(&&text[..3])
        && text[3..].bytes().all(|byte| byte.is_ascii_digit())
}

/// `validation_failed` on `field` when `id` was seen before in its list.
fn unique_id<'a>(seen: &mut HashSet<&'a str>, field: &str, id: &'a str) -> Result<(), ApiError> {
    validate::client_uuid(field, id)?;
    if seen.insert(id) {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "the id is repeated in the file",
        ))
    }
}

pub fn check(request: &CloudImportRequest) -> Result<ValidImport, ApiError> {
    validate::client_uuid("importId", &request.import_id)?;
    if request.format_version != CLOUD_IMPORT_FORMAT_VERSION {
        return Err(ApiError::validation(
            "formatVersion",
            format!("this host reads format version {CLOUD_IMPORT_FORMAT_VERSION}"),
        ));
    }
    if time::OffsetDateTime::parse(
        &request.exported_at,
        &time::format_description::well_known::Rfc3339,
    )
    .is_err()
    {
        return Err(ApiError::validation(
            "exportedAt",
            "an RFC 3339 time is required",
        ));
    }
    validate::clean_text(
        "source.tenantId",
        &request.source.tenant_id,
        100,
        "the tenant",
    )?;
    validate::clean_text(
        "source.tenantName",
        &request.source.tenant_name,
        200,
        "the name",
    )?;
    let payload = &request.payload;
    let org = &payload.organization;
    let org = validate::org(
        "payload.organization",
        &OrgProfileInput {
            name: org.name.clone(),
            inn: org.inn.clone(),
            gln: org.gln.clone(),
            gs1_prefixes: org.gs1_prefixes.clone(),
            time_zone: org.time_zone.clone(),
        },
    )?;
    let badge_salt = match &payload.badge_salt {
        None => None,
        Some(salt) => {
            let bytes = STANDARD
                .decode(salt.expose())
                .ok()
                .filter(|bytes| bytes.len() == 16 && STANDARD.encode(bytes) == salt.expose());
            Some(bytes.ok_or_else(|| {
                ApiError::validation("payload.badgeSalt", "16 bytes in standard base64")
            })?)
        }
    };
    let mut group_refs = Vec::new();

    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    let mut lines = Vec::with_capacity(payload.lines.len());
    for (index, line) in payload.lines.iter().enumerate() {
        unique_id(&mut ids, &format!("payload.lines.{index}.id"), &line.id)?;
        let field = format!("payload.lines.{index}.name");
        let (name, name_key) = validate::line_name(&field, &line.name)?;
        if !keys.insert(name_key.clone()) {
            return Err(ApiError::validation(&field, "line names must be unique"));
        }
        lines.push(Line {
            id: line.id.clone(),
            name,
            name_key,
        });
    }

    let mut ids = HashSet::new();
    let mut counterparties = Vec::with_capacity(payload.counterparties.len());
    for (index, each) in payload.counterparties.iter().enumerate() {
        unique_id(
            &mut ids,
            &format!("payload.counterparties.{index}.id"),
            &each.id,
        )?;
        counterparties.push(Counterparty {
            id: each.id.clone(),
            company: validate::company(
                &format!("payload.counterparties.{index}"),
                &each.name,
                each.inn.as_deref(),
                &each.gln,
                &each.gs1_prefixes,
            )?,
        });
    }

    let mut ids = HashSet::new();
    let mut templates = Vec::with_capacity(payload.templates.len());
    let mut scopes: HashMap<&str, Scope> = HashMap::new();
    for (index, each) in payload.templates.iter().enumerate() {
        let field = |name: &str| format!("payload.templates.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        let name = validate::template_name(&field("name"), &each.name)?;
        let spec = validate::template_spec(&field("spec"), &each.spec)?;
        let codes = each.chz_product_group_codes.as_deref();
        validate::category_codes(&field("chzProductGroupCodes"), codes)?;
        for &code in codes.unwrap_or_default() {
            group_refs.push((field("chzProductGroupCodes"), code));
        }
        scopes.insert(
            &each.id,
            Scope {
                purpose: each.purpose,
                enabled: each.enabled,
                codes: each.chz_product_group_codes.clone(),
            },
        );
        templates.push(Template {
            id: each.id.clone(),
            name,
            purpose: each.purpose,
            enabled: each.enabled,
            codes: each.chz_product_group_codes.clone(),
            spec,
        });
    }

    // A default names a template of the file that fits its slot, as
    // `templates::check_slot` checks one in `PUT /v1/office/template-defaults`.
    let defaults = &payload.template_defaults;
    for (field, id, purpose) in [
        (
            "payload.templateDefaults.defaultBoxTemplateId",
            &defaults.default_box_template_id,
            TemplatePurpose::Box,
        ),
        (
            "payload.templateDefaults.defaultPalletTemplateId",
            &defaults.default_pallet_template_id,
            TemplatePurpose::Pallet,
        ),
    ] {
        if let Some(id) = id {
            if !scopes
                .get(id.as_str())
                .is_some_and(|scope| fits(scope, purpose, None))
            {
                return Err(ApiError::validation(
                    field,
                    "a template of the file that fits this default is required",
                ));
            }
        }
    }
    let mut slots = HashSet::new();
    let mut categories = Vec::with_capacity(defaults.categories.len());
    for (index, each) in defaults.categories.iter().enumerate() {
        let field = format!("payload.templateDefaults.categories.{index}");
        if !slots.insert((each.chz_product_group_code, each.purpose)) {
            return Err(ApiError::validation(
                &field,
                "a category default is given twice",
            ));
        }
        if !scopes
            .get(each.template_id.as_str())
            .is_some_and(|scope| fits(scope, each.purpose, Some(each.chz_product_group_code)))
        {
            return Err(ApiError::validation(
                &format!("{field}.templateId"),
                "a template of the file that fits this default is required",
            ));
        }
        group_refs.push((
            format!("{field}.chzProductGroupCode"),
            each.chz_product_group_code,
        ));
        categories.push(CategoryDefault {
            code: each.chz_product_group_code,
            purpose: each.purpose,
            template_id: each.template_id.clone(),
        });
    }

    let mut ids = HashSet::new();
    let mut gtins_in_use = HashSet::new();
    let mut products = Vec::with_capacity(payload.products.len());
    for (index, each) in payload.products.iter().enumerate() {
        let field = |name: &str| format!("payload.products.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        let gtin14 = validate::gtin14(&field("gtin14"), &each.gtin14)?;
        if !each.archived && !gtins_in_use.insert(gtin14.clone()) {
            return Err(ApiError::validation(
                &field("gtin14"),
                "another product in use has this GTIN",
            ));
        }
        let name = validate::product_name(&field("name"), &each.name)?;
        let print_name = validate::print_name(&field("printName"), each.print_name.as_deref())?;
        validate::count(
            &field("boxCapacity"),
            each.box_capacity,
            validate::MAX_BOX_CAPACITY,
        )?;
        validate::count(
            &field("palletBoxCapacity"),
            each.pallet_box_capacity,
            validate::MAX_PALLET_BOX_CAPACITY,
        )?;
        validate::count(
            &field("shelfLifeDays"),
            each.shelf_life_days,
            validate::MAX_SHELF_LIFE_DAYS,
        )?;
        if let Some(code) = each.chz_product_group_code {
            group_refs.push((field("chzProductGroupCode"), code));
        }
        for (name, id, purpose) in [
            (
                "defaultBoxTemplateId",
                &each.default_box_template_id,
                TemplatePurpose::Box,
            ),
            (
                "defaultPalletTemplateId",
                &each.default_pallet_template_id,
                TemplatePurpose::Pallet,
            ),
        ] {
            if let Some(id) = id {
                if scopes.get(id.as_str()).map(|scope| scope.purpose) != Some(purpose) {
                    return Err(ApiError::validation(
                        &field(name),
                        format!("a {} template of the file is required", purpose.as_str()),
                    ));
                }
            }
        }
        products.push(Product {
            id: each.id.clone(),
            gtin14,
            name,
            print_name,
            group: each.chz_product_group_code,
            box_capacity: each.box_capacity,
            pallet_box_capacity: each.pallet_box_capacity,
            shelf_life_days: each.shelf_life_days,
            default_box_template_id: each.default_box_template_id.clone(),
            default_pallet_template_id: each.default_pallet_template_id.clone(),
            archived: each.archived,
        });
    }

    let mut ids = HashSet::new();
    let mut logins = HashSet::new();
    let mut operators = Vec::with_capacity(payload.operators.len());
    for (index, each) in payload.operators.iter().enumerate() {
        let field = |name: &str| format!("payload.operators.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        validate::operator_login(&field("login"), &each.login)?;
        if !logins.insert(each.login.as_str()) {
            return Err(ApiError::validation(
                &field("login"),
                "the personnel number is repeated in the file",
            ));
        }
        let name = validate::person_name(&field("name"), &each.name)?;
        let role = validate::operator_role(&field("role"), each.role.as_deref())?;
        validate::pin_phc(&field("pinPhc"), each.pin_phc.expose())?;
        operators.push(Operator {
            id: each.id.clone(),
            login: each.login.clone(),
            name,
            role,
            pin_phc: each.pin_phc.expose().to_owned(),
            active: each.active,
        });
    }

    let operator_ids: HashSet<&str> = operators.iter().map(|each| each.id.as_str()).collect();
    let mut ids = HashSet::new();
    let mut hashes = HashSet::new();
    let mut badges = Vec::with_capacity(payload.badges.len());
    for (index, each) in payload.badges.iter().enumerate() {
        let field = |name: &str| format!("payload.badges.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        if !operator_ids.contains(each.operator_id.as_str()) {
            return Err(ApiError::validation(
                &field("operatorId"),
                "an operator of the file is required",
            ));
        }
        let salt = badge_salt.as_deref().ok_or_else(|| {
            ApiError::validation("payload.badgeSalt", "the badges need their salt")
        })?;
        validate::badge_phc(&field("badgePhc"), each.badge_phc.expose(), salt)?;
        if !hashes.insert(each.badge_phc.expose()) {
            return Err(ApiError::validation(
                &field("badgePhc"),
                "the badge is repeated in the file",
            ));
        }
        badges.push(Badge {
            id: each.id.clone(),
            operator_id: each.operator_id.clone(),
            badge_phc: each.badge_phc.expose().to_owned(),
            label: validate::badge_label(&field("label"), each.label.as_deref())?,
        });
    }

    let mut keys = HashSet::new();
    let mut sscc_counters = Vec::with_capacity(payload.sscc_counters.len());
    for (index, each) in payload.sscc_counters.iter().enumerate() {
        let field = |name: &str| format!("payload.ssccCounters.{index}.{name}");
        if each.extension > 1 {
            return Err(ApiError::validation(
                &field("extension"),
                "0 (boxes) or 1 (pallets)",
            ));
        }
        let prefix = &each.issuer_prefix;
        if !(4..=12).contains(&prefix.len()) || !prefix.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ApiError::validation(
                &field("issuerPrefix"),
                "an issuer prefix is 4-12 digits",
            ));
        }
        validate::sscc_serial(
            &field("nextSerial"),
            each.extension,
            prefix,
            each.next_serial,
        )?;
        if !keys.insert((prefix.as_str(), each.extension)) {
            return Err(ApiError::validation(
                &format!("payload.ssccCounters.{index}"),
                "the counter is repeated in the file",
            ));
        }
        sscc_counters.push(SsccCounter {
            issuer_prefix: prefix.clone(),
            extension: each.extension,
            next_serial: each.next_serial,
        });
    }

    let mut months = HashSet::new();
    let mut shift_number_counters = Vec::with_capacity(payload.shift_number_counters.len());
    for (index, each) in payload.shift_number_counters.iter().enumerate() {
        let field = |name: &str| format!("payload.shiftNumberCounters.{index}.{name}");
        if !is_month_key(&each.month_key) {
            return Err(ApiError::validation(
                &field("monthKey"),
                "a month key MONYY is required",
            ));
        }
        if each.last_seq == 0 {
            return Err(ApiError::validation(
                &field("lastSeq"),
                "a number of 1 or more",
            ));
        }
        if !months.insert(each.month_key.as_str()) {
            return Err(ApiError::validation(
                &field("monthKey"),
                "the month is repeated in the file",
            ));
        }
        shift_number_counters.push(ShiftNumberCounter {
            month_key: each.month_key.clone(),
            last_seq: each.last_seq,
        });
    }

    Ok(ValidImport {
        gln: org.gln,
        badge_salt,
        lines,
        counterparties,
        templates,
        default_box_template_id: defaults.default_box_template_id.clone(),
        default_pallet_template_id: defaults.default_pallet_template_id.clone(),
        categories,
        products,
        operators,
        badges,
        sscc_counters,
        shift_number_counters,
        group_refs,
    })
}
```

- [ ] **Step 4: Запуск — проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --locked --test cloud_import_rules`
Expected: `test result: ok. 8 passed`.

- [ ] **Step 5: Мутации**

1. `if !each.archived && !gtins_in_use.insert(gtin14.clone()) {` → `if !gtins_in_use.insert(gtin14.clone()) {` — FAIL `the_golden_file_passes_whole` (архивный товар делит GTIN действующего).
2. `.is_some_and(|scope| fits(scope, purpose, None))` → `.is_some_and(|_scope| true)` — FAIL `a_default_names_a_template_of_the_file_that_fits_its_slot`.
3. В `is_month_key` `text.len() == 5` → `text.len() >= 5` — FAIL `counters_are_checked_against_the_prefixs_serials` (`OCT266`).
4. `if !operator_ids.contains(each.operator_id.as_str()) {` → `if false {` — FAIL `badges_carry_the_files_salt_and_the_domains_count`.

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/cloud_import.rs apps/standalone/host/src/lib.rs \
  apps/standalone/host/src/validate.rs apps/standalone/host/tests/support/app.rs \
  apps/standalone/host/tests/cloud_import_rules.rs
git commit -m "feat(standalone): the import's checks of every row of the file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Хост — `POST /v1/office/import` (одна транзакция, пробный прогон, повтор, пустая площадка, GLN, журнал процесса)

Маршрут: ранний `require_admin`, `check` (задача 5), затем в одной `begin_write`: `require_admin_in` (администратор, выключенный пока запрос ждал блокировку, получает 401), запись о прежнем переносе (тот же `importId` — сохранённый итог с `repeated: true` без записи, ревизии и строки журнала; другой — `already_imported` с `importedAt`), пустая площадка (`site_not_empty`), GLN организации (`org_gln` с `siteGln` и `fileGln`), группы ЧЗ одним чтением, одна `next_revision` и запись всех строк с этой ревизией (соль площадки — если отличается; линии — кроме совпавших по ключу имени с активными; умолчания организации — `coalesce`; счётчики — `INSERT … ON CONFLICT DO UPDATE … WHERE excluded > текущего`, затем чтение итоговых значений). `dryRun` откатывает транзакцию: ни ревизии, ни пробуждения, ни строки журнала. Иначе — строка `import.cloud` и `commit_with_revision`, которая будит потоки станций. Предел тела маршрута — 32 МиБ (`DefaultBodyLimit` только на нём; тело больше — `validation_failed` без `details.field`, как у ApiJson). Тесты закрепляют: точный итог по фикстуре, ревизию +1 и пробуждение ровно этой ревизией, точную строку журнала, каждую из семи сущностей непустой площадки по отдельности, ленту (только активный оператор, запись `site` с солью файла, ровно перенесённые записи с ревизией импорта), вход прежним PIN и бейджами (хеши проверяются `secrets::verify_password`), «только вперёд» у обоих видов счётчиков, повторную проверку роли в транзакции (триггер `turn_the_user_off_at_the_next_activity`), отказ строки, которую отвергает база, и тело больше 2 МиБ. `cloud_import_logs.rs` проводит через журнал процесса отказанный, пробный, выполненный и повторный перенос и ищет в нём хеши, соль и ключи.

**Files:**

- Create: `apps/standalone/host/src/routes/cloud_import.rs`
- Modify: `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`
- Test: `apps/standalone/host/tests/cloud_import.rs`, `apps/standalone/host/tests/cloud_import_logs.rs` (Create)

**Interfaces:**

- Consumes: `cloud_import::{check, ValidImport}` (задача 5); `CloudImportRequest`, `CloudImportSummary`, `SsccCounterValue`, `ShiftNumberCounterValue` (задача 4); `support::app::{admin, cloud_import_request, IMPORT_ID, …}`.
- Produces: `POST /v1/office/import` → `200 CloudImportSummary`; отказы: 403 `forbidden` (не администратор), 401 `unauthorized`/`session`, 400 `validation_failed` (`details.field` — путь строки), 409 `conflict` с `constraint` `already_imported` (`importedAt`), `site_not_empty` (`entity`: `shifts`, `sscc_blocks`, `category_template_defaults`, `products`, `label_templates`, `operators`, `counterparties`), `org_gln` (`siteGln`, `fileGln`); `audit::actions::IMPORT_CLOUD = "import.cloud"`; `routes::cloud_import::MAX_BODY_BYTES = 32 MiB`.

- [ ] **Step 1: Тесты (падающие)**

Создать `apps/standalone/host/tests/cloud_import.rs`:

<!-- prettier-ignore -->
```rust
//! `POST /v1/office/import` (plan IMP): the golden file of the export tool
//! moved into a site after the wizard (`support::app::admin`, whose
//! organization has the file's GLN and whose lines include «Линия 1»).

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, audit_rows, audit_trail, cloud_import_request, host_revision, login,
    plan_shift, seed_office_user, shift_body, shift_setup, turn_the_user_off_at_the_next_activity,
    Admin, IMPORT_ID,
};

const IMPORT: &str = "/v1/office/import";
const FILE_SALT: &str = "bWFya2lyby1iYWRnZS0wMQ==";

fn fixture(name: &str) -> Value {
    let path = format!("{}/../proto/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn scalar_i64(admin: &Admin, query: &str) -> i64 {
    sqlx::query_scalar(query)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// How many rows the import writes, table by table; all zero before it.
async fn imported_rows(admin: &Admin) -> [i64; 6] {
    [
        scalar_i64(admin, "SELECT COUNT(*) FROM products").await,
        scalar_i64(admin, "SELECT COUNT(*) FROM operators").await,
        scalar_i64(admin, "SELECT COUNT(*) FROM operator_badges").await,
        scalar_i64(admin, "SELECT COUNT(*) FROM counterparties").await,
        scalar_i64(
            admin,
            "SELECT COUNT(*) FROM label_templates WHERE stock = 0",
        )
        .await,
        scalar_i64(admin, "SELECT COUNT(*) FROM category_template_defaults").await,
    ]
}

async fn site_salt(admin: &Admin) -> String {
    let (status, body) = admin.call("GET", "/v1/office/badge-salt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["badgeSalt"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn the_import_writes_every_row_at_one_revision_and_writes_one_audit_row() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    assert!(!wake.has_changed().unwrap());

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary, fixture("cloud-import-summary.json"));
    assert_eq!(host_revision(&admin.app).await, before + 1);
    assert!(wake.has_changed().unwrap(), "the import wakes the streams");
    assert_eq!(*wake.borrow_and_update(), before + 1);
    assert_eq!(
        audit_trail(&admin.app, "import.cloud").await,
        [admin.row(
            "import.cloud",
            "site",
            "1",
            json!({
                "importId": IMPORT_ID,
                "exportedAt": "2026-10-09T18:30:00.000Z",
                "rehearsal": false,
                "sourceTenantId": "imp-test-atoll",
                "summary": fixture("cloud-import-summary.json"),
            }),
        )]
    );
    assert_eq!(imported_rows(&admin).await, [3, 3, 3, 2, 5, 2]);
    assert_eq!(site_salt(&admin).await, FILE_SALT);

    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let mut names: Vec<&str> = lines
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["Линия 1", "Линия 2", "Упаковка", "линия 1 (2)"]);

    let (_, defaults) = admin
        .call("GET", "/v1/office/template-defaults", None)
        .await;
    assert_eq!(
        (
            defaults["defaultBoxTemplateId"].clone(),
            defaults["defaultPalletTemplateId"].clone(),
            defaults["categories"].clone(),
        ),
        (
            json!("0d0d0000-0000-4000-8000-000000000001"),
            json!("0d0d0000-0000-4000-8000-000000000003"),
            json!([
                { "chzProductGroupCode": 8, "purpose": "box", "templateId": "0d0d0000-0000-4000-8000-000000000002" },
                { "chzProductGroupCode": 8, "purpose": "pallet", "templateId": "0d0d0000-0000-4000-8000-000000000003" },
            ]),
        )
    );

    let (_, operators) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(
        operators
            .as_array()
            .unwrap()
            .iter()
            .map(|operator| (
                operator["login"].as_str().unwrap(),
                operator["active"].as_bool().unwrap(),
                operator["badges"].as_array().unwrap().len(),
            ))
            .collect::<Vec<_>>(),
        [("0042", true, 2), ("117", false, 1), ("205", false, 0)]
    );

    let months: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY month_key")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        months,
        [
            ("NOV26".to_owned(), 1),
            ("OCT26".to_owned(), 7),
            ("SEP26".to_owned(), 41)
        ]
    );
}

/// The PIN hash and the badge hashes moved as they were: the operator signs
/// in with the cloud's PIN, and a badge code hashed under the site's salt
/// finds its badge (spec §8.3).
#[tokio::test]
async fn an_imported_operator_keeps_the_clouds_pin_and_badges() {
    let admin = admin().await;
    let (status, body) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pin: String = sqlx::query_scalar("SELECT pin_phc FROM operators WHERE login = '0042'")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert!(markiro_host::secrets::verify_password(&pin, "4821"));
    let badges: Vec<String> = sqlx::query_scalar(
        "SELECT badge_phc FROM operator_badges WHERE revoked_at IS NULL ORDER BY id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    for (phc, code) in badges
        .iter()
        .zip(["MRK-000742", "MRK-000743", "MRK-000744"])
    {
        assert!(markiro_host::secrets::verify_password(phc, code), "{code}");
        assert_eq!(
            markiro_host::secrets::parse_phc(phc).unwrap().salt(),
            b"markiro-badge-01"
        );
    }
}

#[tokio::test]
async fn the_feed_carries_every_imported_record_at_the_import_revision() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let (status, body) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = admin.feed(before).await;
    let mut keys: Vec<(String, String, i64, bool)> = items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["entity"].as_str().unwrap().to_owned(),
                item["id"].as_str().unwrap().to_owned(),
                item["rev"].as_i64().unwrap(),
                item["deleted"].as_bool().unwrap(),
            )
        })
        .collect();
    keys.sort();
    let at = |entity: &str, id: &str| (entity.to_owned(), id.to_owned(), before + 1, false);
    let mut expected = vec![
        at("category_template_defaults", "8:box"),
        at("category_template_defaults", "8:pallet"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000001"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000002"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000003"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000004"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000005"),
        at("lines", "0a0a0000-0000-4000-8000-000000000002"),
        at("lines", "0a0a0000-0000-4000-8000-000000000003"),
        at("operator_badges", "0b0b0000-0000-4000-8000-000000000001"),
        at("operator_badges", "0b0b0000-0000-4000-8000-000000000002"),
        at("operator_badges", "0b0b0000-0000-4000-8000-000000000003"),
        // Only the active operator: the feed leaves turned-off ones out.
        at("operators", "0f0f0000-0000-4000-8000-000000000001"),
        at("org_profile", "1"),
        at("products", "0e0e0000-0000-4000-8000-000000000001"),
        at("products", "0e0e0000-0000-4000-8000-000000000002"),
        at("products", "0e0e0000-0000-4000-8000-000000000003"),
        at("site", "1"),
    ];
    expected.sort();
    assert_eq!(keys, expected);
    let site = items
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "site")
        .unwrap();
    assert_eq!(site["data"]["badgeSalt"], FILE_SALT);
}

#[tokio::test]
async fn a_dry_run_checks_everything_and_writes_nothing() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let salt = site_salt(&admin).await;
    let audits = audit_rows(&admin.app).await;
    let wake = admin.app.state.revisions.subscribe();

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, true)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let mut expected = fixture("cloud-import-summary.json");
    expected["dryRun"] = json!(true);
    assert_eq!(summary, expected);
    assert_eq!(host_revision(&admin.app).await, before);
    assert!(!wake.has_changed().unwrap(), "a dry run wakes nobody");
    assert_eq!(audit_rows(&admin.app).await, audits);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
    assert_eq!(site_salt(&admin).await, salt);
    assert_eq!(
        scalar_i64(&admin, "SELECT COUNT(*) FROM shift_number_counters").await,
        0
    );

    // A dry run is no import: the same id imports afterwards.
    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary, fixture("cloud-import-summary.json"));
}

#[tokio::test]
async fn the_same_import_again_answers_its_summary_and_another_is_refused() {
    let admin = admin().await;
    let (status, first) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let after = host_revision(&admin.app).await;
    let audits = audit_rows(&admin.app).await;
    let wake = admin.app.state.revisions.subscribe();

    let (status, again) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let mut expected = fixture("cloud-import-summary.json");
    expected["repeated"] = json!(true);
    assert_eq!(again, expected);
    assert_eq!(host_revision(&admin.app).await, after);
    assert_eq!(audit_rows(&admin.app).await, audits);
    assert!(!wake.has_changed().unwrap());

    let imported_at: String =
        sqlx::query_scalar("SELECT at FROM audit_log WHERE action = 'import.cloud'")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let other = "5f2b8c1e-9a7d-4e3f-8b6a-0c1d2e3f4a5b";
    for dry_run in [false, true] {
        let (status, error) = admin
            .call("POST", IMPORT, Some(cloud_import_request(other, dry_run)))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["error"]["code"], "conflict");
        assert_eq!(
            error["error"]["details"],
            json!({ "constraint": "already_imported", "importedAt": imported_at })
        );
    }
    assert_eq!(host_revision(&admin.app).await, after);
    assert_eq!(audit_rows(&admin.app).await, audits);
}

#[tokio::test]
async fn a_site_that_holds_data_is_refused_and_named() {
    for entity in [
        "shifts",
        "sscc_blocks",
        "category_template_defaults",
        "products",
        "label_templates",
        "operators",
        "counterparties",
    ] {
        let admin = admin().await;
        let pool = &admin.app.state.pool;
        match entity {
            "shifts" => {
                let setup = shift_setup(&admin).await;
                plan_shift(&admin, shift_body(&setup)).await;
            }
            "sscc_blocks" => {
                sqlx::query(
                    "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
                     from_serial, to_serial, issued_at) SELECT 'b1', '460068200', 0, id, 'r1', 1500, 3499, \
                     '2026-10-09T00:00:00Z' FROM devices LIMIT 1",
                )
                .execute(pool)
                .await
                .unwrap();
            }
            "category_template_defaults" => {
                sqlx::query(
                    "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
                     VALUES ('stock-1', 'Типовой', 'box', 1, NULL, '{}', 1, 1)",
                )
                .execute(pool)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
                     VALUES (8, 'box', 'stock-1', 1)",
                )
                .execute(pool)
                .await
                .unwrap();
            }
            "products" => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/products",
                        Some(json!({ "gtin14": "04600682000099", "name": "Сметана" })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            "label_templates" => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/templates",
                        Some(json!({ "name": "Свой", "purpose": "box", "enabled": true, "spec": {} })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            "operators" => {
                add_operator(&admin, "777").await;
            }
            _ => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/counterparties",
                        Some(json!({ "name": "ООО «Ранний»", "gln": "4601234000017", "gs1Prefixes": [] })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
        }
        let before = host_revision(&admin.app).await;
        let audits = audit_rows(&admin.app).await;
        let (status, error) = admin
            .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, true)))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{entity}: {error}");
        assert_eq!(
            error["error"]["details"],
            json!({ "constraint": "site_not_empty", "entity": entity }),
            "{entity}"
        );
        assert_eq!(host_revision(&admin.app).await, before, "{entity}");
        assert_eq!(audit_rows(&admin.app).await, audits, "{entity}");
        assert_eq!(
            scalar_i64(&admin, "SELECT COUNT(*) FROM operator_badges").await,
            0,
            "{entity}"
        );
    }
}

#[tokio::test]
async fn the_organization_must_have_the_files_gln() {
    let admin = admin().await;
    let (_, org) = admin.call("GET", "/v1/office/org", None).await;
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": org["name"], "inn": org["inn"], "gln": "4600682000027",
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before = host_revision(&admin.app).await;
    let (status, error) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"],
        json!({ "constraint": "org_gln", "siteGln": "4600682000027", "fileGln": "4600682000010" })
    );
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
}

#[tokio::test]
async fn counters_only_move_forward() {
    let admin = admin().await;
    let (_, sscc) = admin.call("GET", "/v1/office/sscc", None).await;
    let rev = sscc["counters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|counter| counter["extension"] == 0)
        .unwrap()["rev"]
        .clone();
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/sscc/counters/460068200/0",
            Some(json!({ "nextSerial": 50_000, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    sqlx::query("INSERT INTO shift_number_counters (month_key, last_seq) VALUES ('OCT26', 9)")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(
        summary["ssccCounters"],
        json!([
            { "issuerPrefix": "460068200", "extension": 0, "nextSerial": 50_000 },
            { "issuerPrefix": "460068200", "extension": 1, "nextSerial": 10_000 },
            { "issuerPrefix": "460123400", "extension": 0, "nextSerial": 1 },
        ])
    );
    assert_eq!(
        summary["shiftNumberCounters"],
        json!([
            { "monthKey": "NOV26", "lastSeq": 1 },
            { "monthKey": "OCT26", "lastSeq": 9 },
            { "monthKey": "SEP26", "lastSeq": 41 },
        ])
    );
    let (_, sscc) = admin.call("GET", "/v1/office/sscc", None).await;
    let stands: Vec<(String, u64, u64)> = sscc["counters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|counter| {
            (
                counter["issuerPrefix"].as_str().unwrap().to_owned(),
                counter["extension"].as_u64().unwrap(),
                counter["nextSerial"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        stands,
        [
            ("460068200".to_owned(), 0, 50_000),
            ("460068200".to_owned(), 1, 10_000),
            ("460123400".to_owned(), 0, 1),
        ]
    );
}

#[tokio::test]
async fn only_an_administrator_imports_and_the_role_is_read_again_in_the_write() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, error) = admin
        .call_as(
            &tech,
            "POST",
            IMPORT,
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");

    let second = seed_office_user(&admin.app, "admin2", "admin", "second admin password").await;
    let token = login(&admin.app, &admin.key, "admin2", "second admin password").await;
    turn_the_user_off_at_the_next_activity(&admin.app, &second).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let before = host_revision(&admin.app).await;
    let (status, error) = admin
        .call_as(
            &token,
            "POST",
            IMPORT,
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{error}");
    assert_eq!(error["error"]["details"]["credential"], "session");
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
    assert!(audit_trail(&admin.app, "import.cloud").await.is_empty());
}

#[tokio::test]
async fn a_row_the_database_refuses_refuses_the_whole_import() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    for (pointer, value, field) in [
        // 18 is no ЧЗ product group (the cloud's list skips it).
        (
            "/payload/templates/1/chzProductGroupCodes",
            json!([18]),
            "payload.templates.1.chzProductGroupCodes",
        ),
        (
            "/payload/products/1/chzProductGroupCode",
            json!(99),
            "payload.products.1.chzProductGroupCode",
        ),
    ] {
        let mut body = cloud_import_request(IMPORT_ID, false);
        *body.pointer_mut(pointer).unwrap() = value;
        if field.starts_with("payload.templates") {
            // Keep the category default on T2 valid for the file's rules.
            body["payload"]["templateDefaults"]["categories"] = json!([]);
        }
        let (status, error) = admin.call("POST", IMPORT, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert_eq!(error["error"]["code"], "validation_failed");
        assert_eq!(error["error"]["details"]["field"], field);
    }
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
}

#[tokio::test]
async fn the_route_takes_a_body_past_axums_default_up_to_32_mib() {
    let admin = admin().await;
    let mut body = cloud_import_request(IMPORT_ID, true);
    let templates = body["payload"]["templates"].as_array_mut().unwrap();
    for index in 0..12 {
        templates.push(json!({
            "id": format!("0d0d0000-0000-4000-8000-0000000001{index:02}"),
            "name": format!("Большой {index}"),
            "purpose": "box",
            "enabled": true,
            "chzProductGroupCodes": null,
            "spec": { "widthMm": 58, "text": "я".repeat(120_000) },
        }));
    }
    assert!(body.to_string().len() > 2 * 1024 * 1024);
    let (status, summary) = admin.call("POST", IMPORT, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["templates"], 17);

    let mut huge = cloud_import_request(IMPORT_ID, true);
    huge["source"]["tenantName"] = json!("я".repeat(17 * 1024 * 1024));
    let (status, error) = admin.call("POST", IMPORT, Some(huge)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(error["error"]["code"], "validation_failed");
    assert_eq!(error["error"]["details"], Value::Null);
}
```

Создать `apps/standalone/host/tests/cloud_import_logs.rs`:

<!-- prettier-ignore -->
```rust
//! Plan IMP: the import carries PIN and badge hashes and the badge salt, and
//! none of them reaches the process log, whether the import is refused,
//! tried (`dryRun`), done or repeated. Its own binary, because it installs
//! the global tracing subscriber; it listens on 127.0.0.1, so it runs
//! outside the sandbox.

mod support;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use serde_json::{json, Value};
use support::app::{cloud_import_request, IMPORT_ID};

#[tokio::test]
async fn the_imports_hashes_and_salt_never_reach_the_process_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
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
    let pair: Value = client
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
    let wizard: Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&support::app::bootstrap_body())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = wizard["session"]["token"].as_str().unwrap().to_owned();
    let import = |body: Value| {
        client
            .post(format!("{base}/v1/office/import"))
            .header(protocol.0, &protocol.1)
            .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
            .bearer_auth(&key)
            .json(&body)
            .send()
    };

    // Refused: a badge under another salt; then tried, done and repeated.
    let mut refused = cloud_import_request(IMPORT_ID, false);
    refused["payload"]["badges"][0]["badgePhc"] = json!(
        "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
    );
    assert_eq!(import(refused).await.unwrap().status(), 400);
    for dry_run in [true, false, false] {
        let answer = import(cloud_import_request(IMPORT_ID, dry_run))
            .await
            .unwrap();
        assert_eq!(answer.status(), 200);
    }

    let request = cloud_import_request(IMPORT_ID, false);
    let mut secrets: Vec<String> = vec![
        "pbkdf2$".to_owned(),
        request["payload"]["badgeSalt"].as_str().unwrap().to_owned(),
        hex(b"markiro-badge-01"),
        format!("{:?}", b"markiro-badge-01"),
    ];
    for operator in request["payload"]["operators"].as_array().unwrap() {
        secrets.push(operator["pinPhc"].as_str().unwrap().to_owned());
    }
    for badge in request["payload"]["badges"].as_array().unwrap() {
        let phc = badge["badgePhc"].as_str().unwrap();
        secrets.push(phc.to_owned());
        secrets.push(phc.rsplit('$').next().unwrap().to_owned());
    }
    secrets.push(key);
    secrets.push(token);

    drop(client);
    host.stop().await.unwrap();
    drop(guard);
    let mut log = String::new();
    for entry in std::fs::read_dir(paths.logs_dir()).unwrap() {
        log.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    assert!(
        log.contains("markiro-host listening"),
        "the log must not be empty"
    );
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
```

- [ ] **Step 2: Запуск — падает**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --locked --test cloud_import`
Expected: FAIL — `test result: FAILED. 0 passed; 11 failed` (маршрута нет: ответы `404 Not Found` с `no route for POST /v1/office/import`).

- [ ] **Step 3: Реализация**

В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
```

заменить на

<!-- prettier-ignore -->
```rust
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// The cloud's data moved into this site (plan IMP); the row holds the
    /// import's summary, which a repeat of the same import answers with.
    pub const IMPORT_CLOUD: &str = "import.cloud";
```

В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod changes;
pub mod counterparties;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod changes;
pub mod cloud_import;
pub mod counterparties;
```

Создать `apps/standalone/host/src/routes/cloud_import.rs`:

<!-- prettier-ignore -->
```rust
//! `POST /v1/office/import` (administrators): the cloud's data moved into a
//! new site in one transaction (plan IMP, pilot spec §8.7). The file is
//! checked first (`cloud_import::check`), then, inside the write transaction:
//! the administrator again, an import already done (the same `importId`
//! answers its stored summary, another is `already_imported`), a site that
//! is not empty (`site_not_empty`), the organization's GLN (`org_gln`) and
//! the product groups. Every row of the file is written at one revision and
//! rides the feed; the counters only move forward. `dryRun` runs all of it
//! and rolls back. The audit row `import.cloud` is the import's record: it
//! holds the summary a repeat answers with, and never a hash or the salt.

use std::collections::HashSet;

use axum::extract::State;
use axum::Json;
use markiro_proto::cloud_import::{
    CloudImportRequest, CloudImportSummary, ShiftNumberCounterValue, SsccCounterValue,
};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::cloud_import::{self, ValidImport};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

/// The route's own body limit: a catalog whose layouts reach 256 KB each
/// passes axum's default 2 MiB easily.
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// What a site may not hold before the import, in the order the refusal
/// names it: a row that needs another (a shift its product, a block its
/// device) comes before what it needs, so each entry is the answer for a
/// site that holds only it. Lines may be there (the wizard made them), and
/// so may the wizard's stock templates; badges need operators.
const NOT_EMPTY: [(&str, &str); 7] = [
    ("shifts", "SELECT EXISTS (SELECT 1 FROM shifts)"),
    ("sscc_blocks", "SELECT EXISTS (SELECT 1 FROM sscc_blocks)"),
    (
        "category_template_defaults",
        "SELECT EXISTS (SELECT 1 FROM category_template_defaults)",
    ),
    ("products", "SELECT EXISTS (SELECT 1 FROM products)"),
    (
        "label_templates",
        "SELECT EXISTS (SELECT 1 FROM label_templates WHERE stock = 0)",
    ),
    ("operators", "SELECT EXISTS (SELECT 1 FROM operators)"),
    (
        "counterparties",
        "SELECT EXISTS (SELECT 1 FROM counterparties)",
    ),
];

/// The import already done: its id and its summary, from its audit row.
async fn earlier_import(
    conn: &mut SqliteConnection,
) -> Result<Option<(String, String, CloudImportSummary)>, ApiError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT at, details FROM audit_log WHERE action = ? AND result = 'ok' ORDER BY id LIMIT 1",
    )
    .bind(actions::IMPORT_CLOUD)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((at, details)) = row else {
        return Ok(None);
    };
    let mut details: Value = serde_json::from_str(&details).map_err(ApiError::internal)?;
    let import_id = details["importId"]
        .as_str()
        .ok_or_else(|| ApiError::internal("an import.cloud row without importId"))?
        .to_owned();
    let summary = serde_json::from_value(details["summary"].take()).map_err(ApiError::internal)?;
    Ok(Some((import_id, at, summary)))
}

async fn require_empty(conn: &mut SqliteConnection) -> Result<(), ApiError> {
    for (entity, query) in NOT_EMPTY {
        let found: bool = sqlx::query_scalar(query)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        if found {
            return Err(
                ApiError::conflict("site_not_empty", "the site already holds data")
                    .with_details(json!({ "constraint": "site_not_empty", "entity": entity })),
            );
        }
    }
    Ok(())
}

async fn require_groups(conn: &mut SqliteConnection, valid: &ValidImport) -> Result<(), ApiError> {
    let known: HashSet<u32> = sqlx::query_scalar("SELECT code FROM chz_product_groups")
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?
        .into_iter()
        .collect();
    match valid
        .group_refs
        .iter()
        .find(|(_, code)| !known.contains(code))
    {
        Some((field, _)) => Err(ApiError::validation(field, "no such product group")),
        None => Ok(()),
    }
}

fn count(items: usize) -> Result<u32, ApiError> {
    u32::try_from(items).map_err(ApiError::internal)
}

/// Writes every row of `valid` at `rev`; returns the summary.
async fn write(
    conn: &mut SqliteConnection,
    valid: &ValidImport,
    rev: i64,
    at: &str,
) -> Result<CloudImportSummary, ApiError> {
    let site_salt: Option<Vec<u8>> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    // No operator, so no badge, is on the site yet (`require_empty`): a new
    // salt invalidates nothing, and the `site` record takes it to stations.
    let badge_salt_replaced = match &valid.badge_salt {
        Some(salt) if site_salt.as_deref() != Some(salt.as_slice()) => {
            sqlx::query("UPDATE site SET badge_salt = ?, rev = ? WHERE id = 1")
                .bind(salt.as_slice())
                .bind(rev)
                .execute(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            true
        }
        _ => false,
    };

    let present: HashSet<String> =
        sqlx::query_scalar("SELECT name_key FROM lines WHERE archived = 0")
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?
            .into_iter()
            .collect();
    let mut lines_created = 0;
    for line in &valid.lines {
        if present.contains(&line.name_key) {
            continue;
        }
        sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
            .bind(&line.id)
            .bind(&line.name)
            .bind(&line.name_key)
            .bind(rev)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        lines_created += 1;
    }

    for each in &valid.counterparties {
        let company = &each.company;
        sqlx::query(
            "INSERT INTO counterparties (id, name, inn, gln, gs1_prefixes, archived, rev) \
             VALUES (?, ?, ?, ?, ?, 0, ?)",
        )
        .bind(&each.id)
        .bind(&company.name)
        .bind(&company.inn)
        .bind(&company.gln)
        .bind(serde_json::to_string(&company.gs1_prefixes).map_err(ApiError::internal)?)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    for each in &valid.templates {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        )
        .bind(&each.id)
        .bind(&each.name)
        .bind(each.purpose.as_str())
        .bind(each.enabled)
        .bind(
            each.codes
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(ApiError::internal)?,
        )
        .bind(&each.spec)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    let org_defaults = u32::from(valid.default_box_template_id.is_some())
        + u32::from(valid.default_pallet_template_id.is_some());
    if org_defaults > 0 {
        sqlx::query(
            "UPDATE org_profile SET \
             default_box_template_id = coalesce(?, default_box_template_id), \
             default_pallet_template_id = coalesce(?, default_pallet_template_id), \
             rev = ? WHERE id = 1",
        )
        .bind(&valid.default_box_template_id)
        .bind(&valid.default_pallet_template_id)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    for each in &valid.categories {
        sqlx::query(
            "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(each.code)
        .bind(each.purpose.as_str())
        .bind(&each.template_id)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    for each in &valid.products {
        sqlx::query(
            "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
             pallet_box_capacity, shelf_life_days, default_box_template_id, \
             default_pallet_template_id, archived, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&each.id)
        .bind(&each.gtin14)
        .bind(&each.name)
        .bind(&each.print_name)
        .bind(each.group)
        .bind(each.box_capacity)
        .bind(each.pallet_box_capacity)
        .bind(each.shelf_life_days)
        .bind(&each.default_box_template_id)
        .bind(&each.default_pallet_template_id)
        .bind(each.archived)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    for each in &valid.operators {
        sqlx::query(
            "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&each.id)
        .bind(&each.login)
        .bind(&each.name)
        .bind(&each.role)
        .bind(&each.pin_phc)
        .bind(each.active)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    for each in &valid.badges {
        sqlx::query(
            "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&each.id)
        .bind(&each.operator_id)
        .bind(&each.badge_phc)
        .bind(&each.label)
        .bind(at)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    // Forward only: a counter the site already has above the file's start
    // keeps its value (the wizard's, or one moved on in «SSCC»).
    let mut sscc_counters = Vec::with_capacity(valid.sscc_counters.len());
    for each in &valid.sscc_counters {
        let next = i64::try_from(each.next_serial).map_err(ApiError::internal)?;
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?) \
             ON CONFLICT (issuer_prefix, extension) DO UPDATE SET \
             next_serial = excluded.next_serial, rev = excluded.rev \
             WHERE excluded.next_serial > sscc_counters.next_serial",
        )
        .bind(&each.issuer_prefix)
        .bind(each.extension)
        .bind(next)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        let stands: i64 = sqlx::query_scalar(
            "SELECT next_serial FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?",
        )
        .bind(&each.issuer_prefix)
        .bind(each.extension)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        sscc_counters.push(SsccCounterValue {
            issuer_prefix: each.issuer_prefix.clone(),
            extension: each.extension,
            next_serial: u64::try_from(stands).map_err(ApiError::internal)?,
        });
    }
    let mut shift_number_counters = Vec::with_capacity(valid.shift_number_counters.len());
    for each in &valid.shift_number_counters {
        sqlx::query(
            "INSERT INTO shift_number_counters (month_key, last_seq) VALUES (?, ?) \
             ON CONFLICT (month_key) DO UPDATE SET last_seq = excluded.last_seq \
             WHERE excluded.last_seq > shift_number_counters.last_seq",
        )
        .bind(&each.month_key)
        .bind(each.last_seq)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        let stands: u32 =
            sqlx::query_scalar("SELECT last_seq FROM shift_number_counters WHERE month_key = ?")
                .bind(&each.month_key)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        shift_number_counters.push(ShiftNumberCounterValue {
            month_key: each.month_key.clone(),
            last_seq: stands,
        });
    }

    Ok(CloudImportSummary {
        dry_run: false,
        repeated: false,
        lines_created,
        lines_present: count(valid.lines.len())? - lines_created,
        counterparties: count(valid.counterparties.len())?,
        templates: count(valid.templates.len())?,
        org_defaults,
        category_defaults: count(valid.categories.len())?,
        products: count(valid.products.len())?,
        operators: count(valid.operators.len())?,
        badges: count(valid.badges.len())?,
        badge_salt_replaced,
        sscc_counters,
        shift_number_counters,
    })
}

pub async fn import(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(request): ApiJson<CloudImportRequest>,
) -> Result<Json<CloudImportSummary>, ApiError> {
    context.require_admin()?;
    let valid = cloud_import::check(&request)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    if let Some((import_id, imported_at, summary)) = earlier_import(&mut tx).await? {
        if import_id == request.import_id {
            return Ok(Json(CloudImportSummary {
                repeated: true,
                ..summary
            }));
        }
        return Err(
            ApiError::conflict("already_imported", "this site already took an import")
                .with_details(
                    json!({ "constraint": "already_imported", "importedAt": imported_at }),
                ),
        );
    }
    require_empty(&mut tx).await?;
    let site_gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let site_gln = site_gln.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    if site_gln != valid.gln {
        return Err(
            ApiError::conflict("org_gln", "the organization's GLN is not the file's").with_details(
                json!({
                    "constraint": "org_gln",
                    "siteGln": site_gln,
                    "fileGln": valid.gln,
                }),
            ),
        );
    }
    require_groups(&mut tx, &valid).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let summary = write(&mut tx, &valid, rev, &at).await?;
    if request.dry_run {
        tx.rollback().await.map_err(ApiError::internal)?;
        return Ok(Json(CloudImportSummary {
            dry_run: true,
            ..summary
        }));
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::IMPORT_CLOUD,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "importId": request.import_id,
                "exportedAt": request.exported_at,
                "rehearsal": request.rehearsal,
                "sourceTenantId": request.source.tenant_id,
                "summary": summary,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(summary))
}
```

В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/users",
```

заменить на

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/import",
            post(crate::routes::cloud_import::import).layer(axum::extract::DefaultBodyLimit::max(
                crate::routes::cloud_import::MAX_BODY_BYTES,
            )),
        )
        .route(
            "/v1/office/users",
```

- [ ] **Step 4: Запуск — проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --locked --test cloud_import --test cloud_import_rules`
Expected: `test result: ok. 11 passed` и `test result: ok. 8 passed`.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --locked --test cloud_import_logs`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Мутации (в `host/src/routes/cloud_import.rs`; команда — `--test cloud_import`)**

1. `    if request.dry_run {` → `    if false {` — FAIL `a_dry_run_checks_everything_and_writes_nothing`.
2. `        if import_id == request.import_id {` → `        if false {` — FAIL `the_same_import_again_answers_its_summary_and_another_is_refused`.
3. Удалить строку `    context.require_admin_in(&mut tx).await?;` — FAIL `only_an_administrator_imports_and_the_role_is_read_again_in_the_write`.
4. Строку `             WHERE excluded.next_serial > sscc_counters.next_serial",` заменить на `",` — FAIL `counters_only_move_forward`; то же со строкой `             WHERE excluded.last_seq > shift_number_counters.last_seq",` — FAIL тот же тест.
5. `Some(salt) if site_salt.as_deref() != Some(salt.as_slice()) => {` → `Some(salt) if false && site_salt.as_deref() != Some(salt.as_slice()) => {` — FAIL `the_import_writes_every_row_…`, `the_feed_carries_every_imported_record_…`, `a_dry_run_…`, `the_same_import_again_…`.
6. `commit_with_revision(tx, &state.revisions, rev)` → `commit_with_revision(tx, &state.revisions, 0)` — FAIL `the_import_writes_every_row_at_one_revision_and_writes_one_audit_row`.
7. Удалить строку `    require_groups(&mut tx, &valid).await?;` — FAIL `a_row_the_database_refuses_refuses_the_whole_import`.
8. `("shifts", "SELECT EXISTS (SELECT 1 FROM shifts)"),` → `("shifts", "SELECT 0"),` — FAIL `a_site_that_holds_data_is_refused_and_named` (`shifts`).

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/routes/cloud_import.rs apps/standalone/host/src/routes/mod.rs \
  apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs \
  apps/standalone/host/tests/cloud_import.rs apps/standalone/host/tests/cloud_import_logs.rs
git commit -m "feat(standalone): POST /v1/office/import — one transaction, dry run, repeat, empty site, GLN

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Вебвью — чтение файла переноса, контрольная сумма, запрос (`src/host/cloud-import.ts`, `HostApi.importFromCloud`)

`readCloudExportFile` принимает файл, только если это JSON формата `markiro-cloud-export` версии 1, контрольная сумма сошлась (считается по разобранному значению — пробелы и порядок ключей на диске не важны; изменённый или обрезанный файл отвергается до хоста) и он проходит строгую схему (`payload` повторяет запрос хоста; хеши проверяются `isPinPhc` и `isBadgePhc`, соль — `canonicalSaltSchema`). Причина отказа — одно слово (`json`, `format`, `version`, `checksum`), значения не показываются. `canonicalJson` повторяет `canonical.mjs` (общая проверка — одна и та же строка в обоих наборах и общий эталонный файл). `cloudImportRequest` называет каждое поле. Вызов API — в собственном файле теста, чтобы не трогать общий `test/api.test.ts`.

**Files:**

- Create: `apps/standalone/src/host/cloud-import.ts`
- Modify: `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`
- Test: `apps/standalone/test/cloud-import.test.ts` (Create)

**Interfaces:**

- Consumes: `canonicalSaltSchema`, `templatePurposeSchema`, `templateSpecSchema` (`src/host/protocol.ts`); `isPinPhc`, `isBadgePhc` (`src/lib/credentials.ts`); эталонный файл и фикстура ответа.
- Produces (`src/host/cloud-import.ts`): `CLOUD_EXPORT_FORMAT_VERSION = 1`, `CLOUD_EXPORT_FORMAT`, `cloudImportPayloadSchema`, `cutoverCounterSchema` / `CutoverCounter`, `exportNoteSchema` / `ExportNote`, `cloudExportFileSchema` / `CloudExportFile`, `interface CloudImportRequest`, `cloudImportSummarySchema` / `CloudImportSummary`, `canonicalJson(value): string`, `fileChecksum(file): Promise<string>`, `type CloudFileProblem = "json" | "format" | "version" | "checksum"`, `readCloudExportFile(text): Promise<{ kind: "ok"; file } | { kind: "problem"; problem }>`, `cloudImportRequest(file, importId, dryRun): CloudImportRequest`; `HostApi.importFromCloud(token, request): Promise<CloudImportSummary>` (`POST /v1/office/import`).

- [ ] **Step 1: Тест (падающий)**

Создать `apps/standalone/test/cloud-import.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createHostApi } from "../src/host/api.js";
import type { HostClient } from "../src/host/client.js";
import {
  canonicalJson,
  cloudImportRequest,
  cloudImportSummarySchema,
  fileChecksum,
  readCloudExportFile,
  type CloudExportFile,
} from "../src/host/cloud-import.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixtureText(name: string): string {
  return readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8");
}

const GOLDEN = fixtureText("cloud-export-file.json");
const IMPORT_ID = "8f14e45f-ceea-467a-9d9b-1c7e0b1a2d3e";

async function golden(): Promise<CloudExportFile> {
  const read = await readCloudExportFile(GOLDEN);
  if (read.kind !== "ok") throw new Error(`the golden file reads as ${read.problem}`);
  return read.file;
}

/** The golden file with `change` applied to its parsed value, written back. */
function changed(change: (file: Record<string, unknown>) => void): string {
  const file = JSON.parse(GOLDEN) as Record<string, unknown>;
  change(file);
  return JSON.stringify(file);
}

describe("the cloud export file", () => {
  it("reads the tool's golden file and checks its checksum", async () => {
    const file = await golden();
    expect(file.payload.operators).toHaveLength(3);
    expect(file.cutover.ssccCounters[0]).toEqual({
      issuerPrefix: "460068200",
      extension: 0,
      owner: { kind: "organization" },
      issuedMax: 21003,
      printedMax: 21003,
      standaloneStart: 30000,
      cloudReseedTo: 1030000,
    });
    expect(await fileChecksum(JSON.parse(GOLDEN) as Record<string, unknown>)).toBe(file.checksum);
  });

  it("computes the tool's canonical JSON", () => {
    expect(canonicalJson({ b: [1, { d: null, c: "я" }], a: true })).toBe(
      '{"a":true,"b":[1,{"c":"я","d":null}]}',
    );
  });

  it("ignores whitespace and key order on disk", async () => {
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    const read = await readCloudExportFile(JSON.stringify(reordered));
    expect(read.kind).toBe("ok");
  });

  it("refuses a file that changed after the tool wrote it", async () => {
    const edited = changed((file) => {
      const payload = file.payload as { products: { boxCapacity: number }[] };
      payload.products[0]!.boxCapacity = 24;
    });
    expect(await readCloudExportFile(edited)).toEqual({ kind: "problem", problem: "checksum" });
    const truncated = GOLDEN.slice(0, GOLDEN.length / 2);
    expect(await readCloudExportFile(truncated)).toEqual({ kind: "problem", problem: "json" });
  });

  it("refuses another format or version before its checksum", async () => {
    expect(await readCloudExportFile("[]")).toEqual({ kind: "problem", problem: "format" });
    expect(await readCloudExportFile(changed((file) => (file.format = "other")))).toEqual({
      kind: "problem",
      problem: "format",
    });
    expect(await readCloudExportFile(changed((file) => (file.formatVersion = 2)))).toEqual({
      kind: "problem",
      problem: "version",
    });
  });

  it("refuses a file whose checksum matches but whose shape does not", async () => {
    const unknownField = JSON.parse(GOLDEN) as Record<string, unknown>;
    const payload = unknownField.payload as { products: Record<string, unknown>[] };
    payload.products[0]!.unitPrice = "89.90";
    unknownField.checksum = await fileChecksum(unknownField);
    expect(await readCloudExportFile(JSON.stringify(unknownField))).toEqual({
      kind: "problem",
      problem: "format",
    });
  });

  it("builds the request the host's tests send, every field named", async () => {
    const file = await golden();
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    expect(cloudImportRequest(file, IMPORT_ID, false)).toEqual({
      importId: IMPORT_ID,
      dryRun: false,
      formatVersion: parsed.formatVersion,
      exportedAt: parsed.exportedAt,
      rehearsal: parsed.rehearsal,
      source: parsed.source,
      payload: parsed.payload,
    });
    expect(cloudImportRequest(file, IMPORT_ID, true).dryRun).toBe(true);
  });

  it("reads the host's summary, tolerating fields a newer host adds", () => {
    const summary = JSON.parse(fixtureText("cloud-import-summary.json")) as Record<string, unknown>;
    expect(cloudImportSummarySchema.parse(summary)).toEqual(summary);
    expect(cloudImportSummarySchema.parse({ ...summary, warnings: [] })).toEqual(summary);
  });

  it("posts the request to the import route with the office token", async () => {
    const sent: unknown[] = [];
    const client: HostClient = {
      request: async (method, path, options) => {
        sent.push({ method, path, body: options.body, officeToken: options.officeToken });
        return options.schema.parse(JSON.parse(fixtureText("cloud-import-summary.json")));
      },
    };
    const request = cloudImportRequest(await golden(), IMPORT_ID, true);
    const answer = await createHostApi(client).importFromCloud("office-session-token", request);
    expect(answer.products).toBe(3);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/office/import",
        body: request,
        officeToken: "office-session-token",
      },
    ]);
  });
});
```

- [ ] **Step 2: Запуск — падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/cloud-import.test.ts`
Expected: FAIL — `Failed to resolve import "../src/host/cloud-import.js"` (или `Cannot find module`), `Test Files  1 failed`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/host/cloud-import.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { isBadgePhc, isPinPhc } from "../lib/credentials.js";
import { canonicalSaltSchema, templatePurposeSchema, templateSpecSchema } from "./protocol.js";

/**
 * The cloud → standalone import file (plan IMP, pilot spec §8.7) and the
 * `POST /v1/office/import` request built from it. The export tool
 * (`tools/standalone-export`) writes the file; `payload` mirrors
 * `markiro_proto::cloud_import::CloudImportPayload` and is sent as it is.
 * `proto/fixtures/cloud-export-file.json` is the tool's golden output, which
 * both this module's tests and the host's read.
 *
 * The file holds PIN and badge hashes and the badge salt: nothing here logs
 * it, and a Zod failure is reported by its kind, never by the values.
 */

/** Mirrors `markiro_proto::cloud_import::CLOUD_IMPORT_FORMAT_VERSION`. */
export const CLOUD_EXPORT_FORMAT_VERSION = 1;
export const CLOUD_EXPORT_FORMAT = "markiro-cloud-export";

const idSchema = z.uuid();
const groupCodeSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative().nullable();

/** The payload, exactly as the host's request type reads it: strict at every level. */
export const cloudImportPayloadSchema = z.strictObject({
  organization: z.strictObject({
    name: z.string(),
    inn: z.string().nullable(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    timeZone: z.string(),
  }),
  badgeSalt: canonicalSaltSchema.nullable(),
  lines: z.array(z.strictObject({ id: idSchema, name: z.string() })),
  counterparties: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      inn: z.string().nullable(),
      gln: z.string(),
      gs1Prefixes: z.array(z.string()),
    }),
  ),
  templates: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      purpose: templatePurposeSchema,
      enabled: z.boolean(),
      chzProductGroupCodes: z.array(groupCodeSchema).nullable(),
      spec: templateSpecSchema,
    }),
  ),
  templateDefaults: z.strictObject({
    defaultBoxTemplateId: idSchema.nullable(),
    defaultPalletTemplateId: idSchema.nullable(),
    categories: z.array(
      z.strictObject({
        chzProductGroupCode: groupCodeSchema,
        purpose: templatePurposeSchema,
        templateId: idSchema,
      }),
    ),
  }),
  products: z.array(
    z.strictObject({
      id: idSchema,
      gtin14: z.string(),
      name: z.string(),
      printName: z.string().nullable(),
      chzProductGroupCode: groupCodeSchema.nullable(),
      boxCapacity: countSchema,
      palletBoxCapacity: countSchema,
      shelfLifeDays: countSchema,
      defaultBoxTemplateId: idSchema.nullable(),
      defaultPalletTemplateId: idSchema.nullable(),
      archived: z.boolean(),
    }),
  ),
  operators: z.array(
    z.strictObject({
      id: idSchema,
      login: z.string(),
      name: z.string(),
      role: z.string().nullable(),
      pinPhc: z.string().refine(isPinPhc),
      active: z.boolean(),
    }),
  ),
  badges: z.array(
    z.strictObject({
      id: idSchema,
      operatorId: idSchema,
      badgePhc: z.string().refine(isBadgePhc),
      label: z.string().nullable(),
    }),
  ),
  ssccCounters: z.array(
    z.strictObject({
      issuerPrefix: z.string(),
      extension: z.union([z.literal(0), z.literal(1)]),
      nextSerial: z.number().int().nonnegative(),
    }),
  ),
  shiftNumberCounters: z.array(
    z.strictObject({ monthKey: z.string(), lastSeq: z.number().int().positive() }),
  ),
});
export type CloudImportPayload = z.infer<typeof cloudImportPayloadSchema>;

/** One row of the cut-over table (pilot spec §8.4): what the office shows, nothing it sends. */
export const cutoverCounterSchema = z.strictObject({
  issuerPrefix: z.string(),
  extension: z.union([z.literal(0), z.literal(1)]),
  owner: z.union([
    z.strictObject({ kind: z.literal("organization") }),
    z.strictObject({ kind: z.literal("counterparty"), id: idSchema, name: z.string() }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  issuedMax: z.number().int().nonnegative().nullable(),
  printedMax: z.number().int().nonnegative().nullable(),
  standaloneStart: z.number().int().nonnegative(),
  cloudReseedTo: z.number().int().nonnegative().nullable(),
});
export type CutoverCounter = z.infer<typeof cutoverCounterSchema>;

/**
 * A note of the tool: what it changed or left out. Its fields depend on
 * `code`; the page reads the ones it knows and shows an unknown code as is.
 */
export const exportNoteSchema = z.looseObject({ code: z.string().min(1) });
export type ExportNote = z.infer<typeof exportNoteSchema>;

export const cloudExportFileSchema = z.strictObject({
  format: z.literal(CLOUD_EXPORT_FORMAT),
  formatVersion: z.literal(CLOUD_EXPORT_FORMAT_VERSION),
  tool: z.string(),
  exportedAt: z.iso.datetime(),
  rehearsal: z.boolean(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source: z.strictObject({ tenantId: z.string(), tenantName: z.string() }),
  payload: cloudImportPayloadSchema,
  cutover: z.strictObject({
    boxWindow: z.number().int().positive(),
    palletWindow: z.number().int().positive(),
    ssccCounters: z.array(cutoverCounterSchema),
  }),
  notes: z.array(exportNoteSchema),
});
export type CloudExportFile = z.infer<typeof cloudExportFileSchema>;

/** Mirrors `markiro_proto::cloud_import::CloudImportRequest`; a request, so strict. */
export interface CloudImportRequest {
  importId: string;
  dryRun: boolean;
  formatVersion: number;
  exportedAt: string;
  rehearsal: boolean;
  source: { tenantId: string; tenantName: string };
  payload: CloudImportPayload;
}

/** Mirrors `markiro_proto::cloud_import::CloudImportSummary`; a response, so lenient. */
export const cloudImportSummarySchema = z.object({
  dryRun: z.boolean(),
  repeated: z.boolean(),
  linesCreated: z.number().int().nonnegative(),
  linesPresent: z.number().int().nonnegative(),
  counterparties: z.number().int().nonnegative(),
  templates: z.number().int().nonnegative(),
  orgDefaults: z.number().int().nonnegative(),
  categoryDefaults: z.number().int().nonnegative(),
  products: z.number().int().nonnegative(),
  operators: z.number().int().nonnegative(),
  badges: z.number().int().nonnegative(),
  badgeSaltReplaced: z.boolean(),
  ssccCounters: z.array(
    z.object({
      issuerPrefix: z.string(),
      extension: z.number().int(),
      nextSerial: z.number().int(),
    }),
  ),
  shiftNumberCounters: z.array(z.object({ monthKey: z.string(), lastSeq: z.number().int() })),
});
export type CloudImportSummary = z.infer<typeof cloudImportSummarySchema>;

/**
 * Canonical JSON, as the tool's `canonical.mjs` writes it: object keys
 * sorted, no spaces, values as `JSON.stringify` writes them.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` of the file without its `checksum` field, as the tool's `fileChecksum`. */
export async function fileChecksum(file: Record<string, unknown>): Promise<string> {
  const rest = Object.fromEntries(Object.entries(file).filter(([key]) => key !== "checksum"));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(rest)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

export type CloudFileProblem = "json" | "format" | "version" | "checksum";

export type CloudFileRead =
  { kind: "ok"; file: CloudExportFile } | { kind: "problem"; problem: CloudFileProblem };

/**
 * A file the office may send: JSON, of this format and version, of the
 * expected shape, with a checksum that matches. The checksum is computed on
 * the parsed value, so whitespace and key order on disk do not matter, and
 * a file damaged on its way (a truncated copy, an edit) is refused before
 * anything reaches the host.
 */
export async function readCloudExportFile(text: string): Promise<CloudFileRead> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "problem", problem: "json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "problem", problem: "format" };
  }
  const record = value as Record<string, unknown>;
  if (record.format !== CLOUD_EXPORT_FORMAT) return { kind: "problem", problem: "format" };
  if (record.formatVersion !== CLOUD_EXPORT_FORMAT_VERSION) {
    return { kind: "problem", problem: "version" };
  }
  if ((await fileChecksum(record)) !== record.checksum) {
    return { kind: "problem", problem: "checksum" };
  }
  const parsed = cloudExportFileSchema.safeParse(record);
  return parsed.success
    ? { kind: "ok", file: parsed.data }
    : { kind: "problem", problem: "format" };
}

/** The request for `file`, every field named. */
export function cloudImportRequest(
  file: CloudExportFile,
  importId: string,
  dryRun: boolean,
): CloudImportRequest {
  return {
    importId,
    dryRun,
    formatVersion: file.formatVersion,
    exportedAt: file.exportedAt,
    rehearsal: file.rehearsal,
    source: { tenantId: file.source.tenantId, tenantName: file.source.tenantName },
    payload: file.payload,
  };
}
```

В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
import type { HostClient } from "./client.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import type { HostClient } from "./client.js";
import {
  cloudImportSummarySchema,
  type CloudImportRequest,
  type CloudImportSummary,
} from "./cloud-import.js";
```

В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  updateTemplateDefaults: (
    token: string,
    update: TemplateDefaultsUpdate,
  ) => Promise<TemplateDefaults>;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  updateTemplateDefaults: (
    token: string,
    update: TemplateDefaultsUpdate,
  ) => Promise<TemplateDefaults>;
  /** The cloud's data into a new site, or its trial (`dryRun`); administrators only. */
  importFromCloud: (token: string, request: CloudImportRequest) => Promise<CloudImportSummary>;
}
```

В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        schema: templateDefaultsSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        schema: templateDefaultsSchema,
      }),
    importFromCloud: (token, request) =>
      client.request("POST", "/v1/office/import", {
        body: request,
        officeToken: token,
        schema: cloudImportSummarySchema,
      }),
  };
}
```

В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    updateTemplateDefaults: vi.fn<HostApi["updateTemplateDefaults"]>(() =>
      unexpected("updateTemplateDefaults"),
    ),
```

заменить на

<!-- prettier-ignore -->
```tsx
    updateTemplateDefaults: vi.fn<HostApi["updateTemplateDefaults"]>(() =>
      unexpected("updateTemplateDefaults"),
    ),
    importFromCloud: vi.fn<HostApi["importFromCloud"]>(() => unexpected("importFromCloud")),
```

- [ ] **Step 4: Запуск — проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/cloud-import.test.ts`
Expected: `Tests  9 passed (9)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`
Expected: без ошибок.

- [ ] **Step 5: Мутации**

1. В `readCloudExportFile` удалить проверку `if ((await fileChecksum(record)) !== record.checksum) { … }` (три строки) — FAIL `refuses a file that changed after the tool wrote it`.
2. В `cloudImportPayloadSchema` у элемента `products` `z.strictObject({` → `z.object({` — FAIL `refuses a file whose checksum matches but whose shape does not`.
3. В `canonicalJson` удалить `.sort()` — FAIL `reads the tool's golden file and checks its checksum` и `computes the tool's canonical JSON`.

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check apps/standalone/src/host/cloud-import.ts apps/standalone/src/host/api.ts \
  apps/standalone/test/cloud-import.test.ts apps/standalone/test/support/office.tsx
git diff --check
git add apps/standalone/src/host/cloud-import.ts apps/standalone/src/host/api.ts \
  apps/standalone/test/cloud-import.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the office reads the import file and checks its checksum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Вебвью — страница «Сервис → Перенос из облака»

Страница для администраторов (`RequireRole`, пункт меню в новом разделе «Сервис»). Файл выбирается `FileDropZone` (`.json`); отказ чтения — словами по причине. По прочитанному файлу показываются: пометка пробного файла, организация из файла и предупреждение, если GLN площадки (`GET /v1/office/org`) другой, таблица SSCC (префикс, что, чей, «облако выдало до», «автоном начнёт с», «облако перевести на» или «окно не помещается»), номера смен, замечания выгрузки словами (`import-notes.ts`: запись названа по имени из файла или по первым восьми символам id, если инструмент её выбросил; незнакомый код показывается как есть). «Проверить» шлёт `dryRun`; «Перенести» доступна только после успешной проверки и спрашивает подтверждение (`FormDialog`). `importId` — один на прочитанный файл (`crypto.randomUUID()`), поэтому повтор после потерянного ответа — тот же перенос и получает итог с пометкой «уже перенесён»; новый файл — новый `importId`. Отказы хоста — словами (`site_not_empty` с сущностью, `already_imported`, `org_gln`, строка файла по пути, прочее — `errorMessageKey`). После переноса — итог, напоминания удалить файл и перевести облачные счётчики, сброс кеша офиса (`resetQueries`).

**Files:**

- Create: `apps/standalone/src/office/import/import-notes.ts`, `apps/standalone/src/office/import/CloudImportPage.tsx`
- Modify: `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/cloud-import-page.test.tsx` (Create)

**Interfaces:**

- Consumes: всё из задачи 7; `FormDialog`, `useOfficeQuery`, `useOfficeMutation`, `officeKeys`, `RequireRole`, `errorMessageKey`, `HostError`; `@markiro/ui`: `Alert`, `Button`, `Card`, `DefinitionGrid`, `FileDropZone`, `PageHeader`, `Table`.
- Produces: `CloudImportPage` (маршрут `/import`), `noteText(t, note, file): string`; ключи i18n `office.nav.cloudImport`, `office.nav.sections.service`, `office.cloudImport.*`.

- [ ] **Step 1: Тест (падающий)**

Создать `apps/standalone/test/cloud-import-page.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  cloudImportSummarySchema,
  fileChecksum,
  readCloudExportFile,
  type CloudExportFile,
  type CloudImportRequest,
} from "../src/host/cloud-import.js";
import i18n from "../src/i18n/index.js";
import { noteText } from "../src/office/import/import-notes.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const GOLDEN = readFileSync(
  new URL("../proto/fixtures/cloud-export-file.json", testModuleUrl),
  "utf8",
);
const SUMMARY = cloudImportSummarySchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/cloud-import-summary.json", testModuleUrl), "utf8"),
  ),
);
/** The site's profile with the file's GLN, as after a wizard run from the file. */
const SITE_ORG = { ...ORG_PROFILE, gln: "4600682000010" };

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(SITE_ORG);
  return session;
}

async function openImport(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Перенос из облака" }));
  await screen.findByRole("heading", { name: "Перенос из облака" });
}

function choose(text: string): void {
  fireEvent.change(screen.getByTestId("file-drop-input"), {
    target: {
      files: [new File([text], "markiro-cloud-export.json", { type: "application/json" })],
    },
  });
}

/** The golden file with `change` applied, its checksum computed again. */
async function rewritten(change: (file: Record<string, unknown>) => void): Promise<string> {
  const file = JSON.parse(GOLDEN) as Record<string, unknown>;
  change(file);
  file.checksum = await fileChecksum(file);
  return JSON.stringify(file);
}

function sent(session: FakeOfficeSession): CloudImportRequest[] {
  return session.api.importFromCloud.mock.calls.map(([, request]) => request);
}

describe("«Перенос из облака»", () => {
  it("is in the menu of an administrator only", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    renderOffice(session);
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Перенос из облака" })).toBeNull();
  });

  it("refuses a damaged file before anything reaches the host", async () => {
    const session = adminSession();
    await openImport(session);
    choose(GOLDEN.replace('"boxCapacity": 12', '"boxCapacity": 24'));
    expect(
      await screen.findByText(
        "Контрольная сумма не сходится: файл изменён или повреждён после выгрузки. Сделайте выгрузку заново.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
    expect(session.api.importFromCloud).not.toHaveBeenCalled();
  });

  it("shows the file, the counters and the notes, and imports only after a check", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockResolvedValueOnce(SUMMARY);
    await openImport(session);
    choose(GOLDEN);

    expect(await screen.findByText("ООО «Атолл», ИНН 7701234567, GLN 4600682000010")).toBeTruthy();
    expect(screen.queryByText(/не совпадает с файлом/)).toBeNull();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText("30000")).toBeTruthy();
    expect(within(rows[1]!).getByText("1030000")).toBeTruthy();
    expect(within(rows[3]!).getByText("контрагента «ООО «Берег»»")).toBeTruthy();
    expect(
      screen.getByText("Номера смен продолжат облачные: NOV26 → 1, OCT26 → 7, SEP26 → 41."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Замечания выгрузки: 24" })).toBeTruthy();
    expect(
      screen.getByText(
        "Линия « линия 1 » переименована в «линия 1 (2)»: имена линий не повторяются.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Оператор #0f0f0000 не перенесён: табельный номер не из 3–12 цифр."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(
      await screen.findByText("Проверка пройдена: перенос запишет то, что ниже."),
    ).toBeTruthy();
    const [trial] = sent(session);
    expect(trial?.dryRun).toBe(true);
    expect(trial?.importId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const read = await readCloudExportFile(GOLDEN);
    expect(trial?.payload).toEqual((read as { file: CloudExportFile }).file.payload);

    fireEvent.click(screen.getByRole("button", { name: "Перенести" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    expect(
      await screen.findByText(
        "Данные облака перенесены. Станции получат их при следующей синхронизации.",
      ),
    ).toBeTruthy();
    const [, done] = sent(session);
    expect(done?.dryRun).toBe(false);
    expect(done?.importId).toBe(trial?.importId);
    expect(
      screen.getByText("Удалите файл переноса с флешки и с этого ПК: в нём хеши PIN и бейджей."),
    ).toBeTruthy();
    // The office's cached data was dropped: the profile is read again.
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
  });

  it("says a site's other GLN before the import, and the host's refusals in words", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    const refusal = (constraint: string, details: Record<string, unknown>) =>
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "refused",
        details: { constraint, ...details },
      });
    session.api.importFromCloud
      .mockRejectedValueOnce(
        refusal("org_gln", { siteGln: "4600682000013", fileGln: "4600682000010" }),
      )
      .mockRejectedValueOnce(refusal("site_not_empty", { entity: "products" }))
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          status: 400,
          message: "refused",
          details: { field: "payload.badges.0.badgePhc" },
        }),
      );
    await openImport(session);
    choose(GOLDEN);
    expect(
      await screen.findByText(
        "GLN организации на этой площадке (4600682000013) не совпадает с файлом (4600682000010): перенос будет отклонён. Исправьте GLN на странице «Профиль».",
      ),
    ).toBeTruthy();
    const check = screen.getByRole("button", { name: "Проверить" });
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "GLN организации на площадке (4600682000013) не совпадает с файлом (4600682000010). Исправьте GLN на странице «Профиль» и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "На площадке уже есть данные (товары): перенос возможен только на новую площадку.",
      ),
    ).toBeTruthy();
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "Автоном не принял строку файла (payload.badges.0.badgePhc): файл повреждён или сделан другой версией выгрузки.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", true);
  });

  it("sends the same import again after a lost answer", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "lost" }),
      )
      .mockResolvedValueOnce({ ...SUMMARY, repeated: true });
    await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    fireEvent.click(screen.getByRole("button", { name: "Перенести" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    await waitFor(() => expect(session.api.importFromCloud).toHaveBeenCalledTimes(2));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    expect(
      await screen.findByText("Этот файл уже перенесён на площадку: показан итог того переноса."),
    ).toBeTruthy();
    const ids = sent(session).map((request) => request.importId);
    expect(new Set(ids).size).toBe(1);
    expect(sent(session).map((request) => request.dryRun)).toEqual([true, false, false]);
  });

  it("marks a rehearsal file and reads a new file as a new import", async () => {
    const session = adminSession();
    session.api.importFromCloud.mockResolvedValue({ ...SUMMARY, dryRun: true });
    await openImport(session);
    choose(
      await rewritten((file) => {
        file.rehearsal = true;
        file.notes = [
          { code: "active_shift", number: "OCT26-008/S" },
          ...(file.notes as unknown[]),
        ];
      }),
    );
    expect(
      await screen.findByText(
        "Пробный файл: облако при выгрузке не было чистым (открытая смена или станция без синхронизации). Для переключения он не годится.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Смена OCT26-008/S не была закрыта в облаке.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    choose(GOLDEN);
    await waitFor(() =>
      expect(screen.queryByText("Проверка пройдена: перенос запишет то, что ниже.")).toBeNull(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    const ids = sent(session).map((request) => request.importId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(sent(session)[1]?.rehearsal).toBe(false);
  });
});

describe("the notes of the export tool", () => {
  it("has words for every code the tool writes, and names an unknown one", async () => {
    const read = await readCloudExportFile(GOLDEN);
    const file = (read as { file: CloudExportFile }).file;
    const t = i18n.t.bind(i18n);
    const say = (note: Record<string, unknown>) =>
      noteText(t, { code: "unknown", ...note } as never, file);
    expect(say({ code: "device_out_of_sync", name: "Станция 1" })).toBe(
      "Станция «Станция 1» не отправила данные в облако после последнего закрытия смены.",
    );
    expect(say({ code: "time_zone_replaced", value: "MSK" })).toBe(
      "Часовой пояс «MSK» заменён на Europe/Moscow.",
    );
    expect(say({ code: "line_dropped", id: "0a0a0000-0000-4000-8000-000000000009" })).toBe(
      "Линия без названия не перенесена.",
    );
    expect(say({ code: "badge_salt_created" })).toBe(
      "У организации в облаке не было соли бейджей: создана новая.",
    );
    expect(say({ code: "sscc_window_does_not_fit", issuerPrefix: "460068200", extension: 1 })).toBe(
      "Окно отката не помещается в префикс 460068200 (паллеты): облачный счётчик при откате переводится вручную.",
    );
    expect(
      say({
        code: "text_changed",
        entity: "products",
        id: "0e0e0000-0000-4000-8000-000000000001",
        field: "printName",
      }),
    ).toBe(
      "Товар «Молоко 3,2% 0,9 л»: в поле «название для печати» убраны управляющие символы или текст сокращён до допустимой длины.",
    );
    expect(say({ code: "something_new" })).toBe("Замечание «something_new».");
    // Every note of the golden file has its words (a missing key throws in tests).
    for (const note of file.notes) expect(noteText(t, note, file)).not.toBe("");
  });
});
```

- [ ] **Step 2: Запуск — падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/cloud-import-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/office/import/import-notes.js"` (или `Cannot find module`), `Test Files  1 failed`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/import/import-notes.ts`:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type { CloudExportFile, ExportNote } from "../../host/cloud-import.js";

/** Codes `office.cloudImport.notes` has a text for (the tool's `transform.mjs`). */
const KNOWN = new Set([
  "active_shift",
  "device_out_of_sync",
  "text_changed",
  "inn_dropped",
  "gs1_prefix_dropped",
  "time_zone_replaced",
  "line_renamed",
  "line_dropped",
  "counterparty_dropped",
  "counterparty_notes_lost",
  "template_dropped",
  "template_default_dropped",
  "product_dropped",
  "product_value_cleared",
  "product_template_dropped",
  "product_fields_lost",
  "operator_dropped",
  "badge_dropped",
  "badges_rehashed",
  "badge_salt_created",
  "badges_not_operators",
  "counterparty_sscc_used",
  "planned_shifts_not_moved",
  "sscc_window_does_not_fit",
]);

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/**
 * A record a note names: by its name in the file, or by the first eight
 * characters of its id when the tool left it out.
 */
function recordName(file: CloudExportFile, entity: string, id: unknown): string {
  const key = text(id);
  const { payload } = file;
  const named =
    entity === "products"
      ? payload.products.find((each) => each.id === key)?.name
      : entity === "counterparties"
        ? payload.counterparties.find((each) => each.id === key)?.name
        : entity === "templates"
          ? payload.templates.find((each) => each.id === key)?.name
          : entity === "operators"
            ? payload.operators.find((each) => each.id === key)?.name
            : undefined;
  if (named !== undefined) return `«${named}»`;
  return key === "" ? "" : `#${key.slice(0, 8)}`;
}

/** The entity a note's code is about, for codes that name a record without `entity`. */
const ENTITY_OF: Readonly<Record<string, string>> = {
  counterparty_dropped: "counterparties",
  template_dropped: "templates",
  product_dropped: "products",
  product_value_cleared: "products",
  product_template_dropped: "products",
  operator_dropped: "operators",
};

/** What a note says, in words. */
export function noteText(t: TFunction, note: ExportNote, file: CloudExportFile): string {
  if (!KNOWN.has(note.code)) return t("office.cloudImport.notes.unknown", { code: note.code });
  const entity = text(note.entity) || ENTITY_OF[note.code] || "";
  const reason = text(note.reason);
  const field = text(note.field);
  const extension = note.extension === 1 ? "pallet" : "box";
  return t(`office.cloudImport.notes.${note.code}`, {
    number: text(note.number),
    name: text(note.name),
    entity: entity === "" ? "" : t(`office.cloudImport.entities.${entity}`),
    record: recordName(file, entity, note.id),
    field: field === "" ? "" : t(`office.cloudImport.fields.${field}`),
    value: text(note.value),
    from: text(note.from),
    to: text(note.to),
    count: text(note.count),
    reason: reason === "" ? "" : t(`office.cloudImport.reasons.${reason}`),
    slot: t(`office.cloudImport.purposes.${text(note.purpose) || "box"}`),
    issuerPrefix: text(note.issuerPrefix),
    kind: t(`office.cloudImport.kinds.${extension}`),
  });
}
```

Создать `apps/standalone/src/office/import/CloudImportPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  DefinitionGrid,
  FileDropZone,
  PageHeader,
  Table,
  type DefinitionGridItem,
  type TableColumn,
} from "@markiro/ui";

import { HostError } from "../../host/client.js";
import {
  cloudImportRequest,
  readCloudExportFile,
  type CloudExportFile,
  type CloudFileProblem,
  type CloudImportRequest,
  type CloudImportSummary,
  type CutoverCounter,
} from "../../host/cloud-import.js";
import { errorMessageKey } from "../../host/errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { noteText } from "./import-notes.js";

/** «Перенос из облака» (plan IMP, administrators): the cloud's file into this new site. */
export function CloudImportPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.cloudImport.title")} />
      <CloudImportContent />
    </>
  );
}

interface Loaded {
  file: CloudExportFile;
  /** One per file read: a repeat after a lost answer is the same import. */
  importId: string;
}

/** The text of a refused import, in words, by its code and constraint. */
function failureText(t: TFunction, error: unknown): string {
  if (error instanceof HostError && error.kind === "api") {
    const details = error.details;
    const value = (key: string) => (typeof details[key] === "string" ? details[key] : "");
    if (error.code === "conflict" && details.constraint === "site_not_empty") {
      return t("office.cloudImport.failure.siteNotEmpty", {
        entity: t(`office.cloudImport.siteEntities.${value("entity") || "unknown"}`),
      });
    }
    if (error.code === "conflict" && details.constraint === "already_imported") {
      return t("office.cloudImport.failure.alreadyImported", { at: value("importedAt") });
    }
    if (error.code === "conflict" && details.constraint === "org_gln") {
      return t("office.cloudImport.failure.orgGln", {
        site: value("siteGln"),
        file: value("fileGln"),
      });
    }
    if (error.code === "validation_failed" && error.field !== null) {
      return t("office.cloudImport.failure.row", { field: error.field });
    }
  }
  return t(errorMessageKey(error));
}

function CloudImportContent() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const send = useOfficeMutation((api, token, request: CloudImportRequest) =>
    api.importFromCloud(token, request),
  );
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<CloudFileProblem | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [trial, setTrial] = useState<CloudImportSummary | null>(null);
  const [done, setDone] = useState<CloudImportSummary | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);

  const choose = async (picked: File) => {
    setReading(true);
    setProblem(null);
    setLoaded(null);
    setTrial(null);
    setDone(null);
    setFailure(null);
    const read = await readCloudExportFile(await picked.text());
    setReading(false);
    if (read.kind === "problem") {
      setProblem(read.problem);
      return;
    }
    setLoaded({ file: read.file, importId: crypto.randomUUID() });
  };

  const run = async (dryRun: boolean): Promise<void> => {
    if (loaded === null) return;
    setFailure(null);
    let summary: CloudImportSummary;
    try {
      summary = await send.mutateAsync(cloudImportRequest(loaded.file, loaded.importId, dryRun));
    } catch (error) {
      setFailure(error);
      return;
    }
    if (dryRun) {
      setTrial(summary);
      return;
    }
    setConfirming(false);
    setDone(summary);
    // Every catalog and people list changed under the office's cache.
    await queryClient.resetQueries({ queryKey: ["office"] });
  };

  const file = loaded?.file ?? null;
  const siteGln = org.data?.gln ?? null;
  const counts = (summary: CloudImportSummary): DefinitionGridItem[] => [
    {
      id: "lines",
      term: t("office.cloudImport.counts.lines"),
      description: t("office.cloudImport.counts.linesValue", {
        created: summary.linesCreated,
        present: summary.linesPresent,
      }),
    },
    {
      id: "counterparties",
      term: t("office.cloudImport.counts.counterparties"),
      description: summary.counterparties,
    },
    {
      id: "templates",
      term: t("office.cloudImport.counts.templates"),
      description: t("office.cloudImport.counts.templatesValue", {
        templates: summary.templates,
        defaults: summary.orgDefaults + summary.categoryDefaults,
      }),
    },
    {
      id: "products",
      term: t("office.cloudImport.counts.products"),
      description: summary.products,
    },
    {
      id: "operators",
      term: t("office.cloudImport.counts.operators"),
      description: summary.operators,
    },
    { id: "badges", term: t("office.cloudImport.counts.badges"), description: summary.badges },
  ];
  const counterColumns: TableColumn<CutoverCounter>[] = [
    {
      key: "prefix",
      title: t("office.cloudImport.sscc.prefix"),
      mono: true,
      render: (row) => row.issuerPrefix,
    },
    {
      key: "kind",
      title: t("office.cloudImport.sscc.kind"),
      render: (row) => t(`office.cloudImport.kinds.${row.extension === 1 ? "pallet" : "box"}`),
    },
    {
      key: "owner",
      title: t("office.cloudImport.sscc.owner"),
      render: (row) =>
        row.owner.kind === "counterparty"
          ? t("office.cloudImport.sscc.counterparty", { name: row.owner.name })
          : t(`office.cloudImport.sscc.${row.owner.kind}`),
    },
    {
      key: "issued",
      title: t("office.cloudImport.sscc.issued"),
      mono: true,
      align: "right",
      render: (row) => (row.issuedMax === null ? t("office.common.none") : String(row.issuedMax)),
    },
    {
      key: "start",
      title: t("office.cloudImport.sscc.start"),
      mono: true,
      align: "right",
      render: (row) => String(row.standaloneStart),
    },
    {
      key: "cloud",
      title: t("office.cloudImport.sscc.cloud"),
      mono: true,
      align: "right",
      render: (row) =>
        row.cloudReseedTo === null
          ? t("office.cloudImport.sscc.noWindow")
          : String(row.cloudReseedTo),
    },
  ];

  return (
    <>
      <p>{t("office.cloudImport.intro")}</p>
      <FileDropZone
        label={t("office.cloudImport.choose")}
        hint={t("office.cloudImport.chooseHint")}
        accept=".json,application/json"
        busy={reading}
        disabled={send.isPending}
        onFile={(picked) => void choose(picked)}
      />
      {problem !== null && (
        <Alert tone="error">{t(`office.cloudImport.problems.${problem}`)}</Alert>
      )}
      {file !== null && (
        <>
          {file.rehearsal && <Alert tone="warn">{t("office.cloudImport.rehearsal")}</Alert>}
          <Card title={t("office.cloudImport.fileTitle")} titleAs="h2">
            <DefinitionGrid
              items={[
                {
                  id: "source",
                  term: t("office.cloudImport.source"),
                  description: file.source.tenantName,
                },
                {
                  id: "exportedAt",
                  term: t("office.cloudImport.exportedAt"),
                  description: file.exportedAt,
                  mono: true,
                },
                {
                  id: "org",
                  term: t("office.cloudImport.org"),
                  description: t("office.cloudImport.orgValue", {
                    name: file.payload.organization.name,
                    inn: file.payload.organization.inn ?? t("office.common.none"),
                    gln: file.payload.organization.gln,
                  }),
                },
              ]}
            />
            {siteGln !== null && siteGln !== file.payload.organization.gln && (
              <Alert tone="error">
                {t("office.cloudImport.glnMismatch", {
                  site: siteGln,
                  file: file.payload.organization.gln,
                })}
              </Alert>
            )}
          </Card>
          <Card title={t("office.cloudImport.ssccTitle")} titleAs="h2">
            <p>{t("office.cloudImport.ssccHint")}</p>
            <Table
              columns={counterColumns}
              rows={file.cutover.ssccCounters}
              getRowKey={(row) => `${row.issuerPrefix}:${row.extension}`}
              empty={t("office.cloudImport.sscc.empty")}
            />
            <p>
              {t("office.cloudImport.shiftNumbers", {
                months:
                  file.payload.shiftNumberCounters
                    .map((each) => `${each.monthKey} → ${each.lastSeq}`)
                    .join(", ") || t("office.common.none"),
              })}
            </p>
          </Card>
          <Card
            title={t("office.cloudImport.notesTitle", { count: file.notes.length })}
            titleAs="h2"
          >
            {file.notes.length === 0 ? (
              <p>{t("office.cloudImport.noNotes")}</p>
            ) : (
              <ul>
                {file.notes.map((note, index) => (
                  <li key={index}>{noteText(t, note, file)}</li>
                ))}
              </ul>
            )}
          </Card>
          {failure !== null && <Alert tone="error">{failureText(t, failure)}</Alert>}
          {trial !== null && done === null && (
            <Card title={t("office.cloudImport.trialTitle")} titleAs="h2">
              <Alert tone="ok">
                {trial.repeated
                  ? t("office.cloudImport.repeated")
                  : t("office.cloudImport.trialOk")}
              </Alert>
              <DefinitionGrid items={counts(trial)} />
            </Card>
          )}
          {done !== null && (
            <Card title={t("office.cloudImport.doneTitle")} titleAs="h2">
              <Alert tone="ok">
                {done.repeated ? t("office.cloudImport.repeated") : t("office.cloudImport.doneOk")}
              </Alert>
              <DefinitionGrid items={counts(done)} />
              <ul>
                <li>{t("office.cloudImport.afterDeleteFile")}</li>
                <li>{t("office.cloudImport.afterCloudCounters")}</li>
              </ul>
            </Card>
          )}
          {done === null && (
            <div className="standalone-actions">
              <Button variant="secondary" disabled={send.isPending} onClick={() => void run(true)}>
                {t("office.cloudImport.check")}
              </Button>
              <Button
                disabled={send.isPending || trial === null}
                onClick={() => {
                  setFailure(null);
                  setConfirming(true);
                }}
              >
                {t("office.cloudImport.import")}
              </Button>
            </div>
          )}
          {confirming && (
            <FormDialog
              title={t("office.cloudImport.confirmTitle")}
              submitLabel={t("office.cloudImport.import")}
              onSubmit={() => run(false)}
              onClose={() => setConfirming(false)}
              alert={
                failure === null ? null : <Alert tone="error">{failureText(t, failure)}</Alert>
              }
            >
              <p>{t("office.cloudImport.confirmText")}</p>
            </FormDialog>
          )}
        </>
      )}
    </>
  );
}
```

В `apps/standalone/src/office/nav.ts` фрагмент

<!-- prettier-ignore -->
```ts
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
    roles: ["admin"],
  },
];
```

заменить на

<!-- prettier-ignore -->
```ts
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
    roles: ["admin"],
  },
  {
    to: "/import",
    labelKey: "office.nav.cloudImport",
    sectionKey: "office.nav.sections.service",
    roles: ["admin"],
  },
];
```

В `apps/standalone/src/office/routes.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { DevicesPage } from "./devices/DevicesPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { DevicesPage } from "./devices/DevicesPage.js";
import { CloudImportPage } from "./import/CloudImportPage.js";
```

В `apps/standalone/src/office/routes.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            <OfficeUsersPage />
          </RequireRole>
        ),
      },
    ],
```

заменить на

<!-- prettier-ignore -->
```tsx
            <OfficeUsersPage />
          </RequireRole>
        ),
      },
      {
        path: "import",
        element: (
          <RequireRole roles={["admin"]}>
            <CloudImportPage />
          </RequireRole>
        ),
      },
    ],
```

В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "catalog": "Каталог",
        "access": "Доступ"
      },
```

заменить на

<!-- prettier-ignore -->
```json
        "catalog": "Каталог",
        "access": "Доступ",
        "service": "Сервис"
      },
```

В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "templateDefaults": "Умолчания шаблонов",
      "users": "Пользователи"
    },
```

заменить на

<!-- prettier-ignore -->
```json
      "templateDefaults": "Умолчания шаблонов",
      "users": "Пользователи",
      "cloudImport": "Перенос из облака"
    },
```

В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "wrongCurrent": "Текущий пароль неверен."
    }
  },
```

заменить на

<!-- prettier-ignore -->
```json
      "wrongCurrent": "Текущий пароль неверен."
    },
    "cloudImport": {
      "title": "Перенос из облака",
      "intro": "Файл переноса делает выгрузка из облака (tools/standalone-export). Перенос возможен один раз и только на новую площадку: после мастера, до первого товара, оператора и смены. Сначала проверка: она проходит все правила и ничего не записывает.",
      "choose": "Выберите файл переноса",
      "chooseHint": "markiro-cloud-export-….json с флешки",
      "problems": {
        "json": "Это не файл переноса: он не читается как JSON или обрезан.",
        "format": "Это не файл переноса этой версии автонома.",
        "version": "Файл сделан другой версией выгрузки: эта версия автонома его не читает.",
        "checksum": "Контрольная сумма не сходится: файл изменён или повреждён после выгрузки. Сделайте выгрузку заново."
      },
      "rehearsal": "Пробный файл: облако при выгрузке не было чистым (открытая смена или станция без синхронизации). Для переключения он не годится.",
      "fileTitle": "Файл",
      "source": "Организация в облаке",
      "exportedAt": "Выгружено",
      "org": "Реквизиты",
      "orgValue": "{{name}}, ИНН {{inn}}, GLN {{gln}}",
      "glnMismatch": "GLN организации на этой площадке ({{site}}) не совпадает с файлом ({{file}}): перенос будет отклонён. Исправьте GLN на странице «Профиль».",
      "ssccTitle": "SSCC и номера смен",
      "ssccHint": "Автоном начнёт с номеров из таблицы. Облачные счётчики после выгрузки переводятся на значения последней колонки — так при откате облако не повторит ни один номер автонома.",
      "sscc": {
        "prefix": "Префикс",
        "kind": "Что",
        "owner": "Чей",
        "organization": "организации",
        "counterparty": "контрагента «{{name}}»",
        "unknown": "неизвестно",
        "issued": "Облако выдало до",
        "start": "Автоном начнёт с",
        "cloud": "Облако перевести на",
        "noWindow": "окно не помещается",
        "empty": "SSCC в облаке не выдавались"
      },
      "kinds": {
        "box": "короба",
        "pallet": "паллеты"
      },
      "purposes": {
        "box": "короб",
        "pallet": "паллета"
      },
      "shiftNumbers": "Номера смен продолжат облачные: {{months}}.",
      "notesTitle": "Замечания выгрузки: {{count}}",
      "noNotes": "Выгрузка ничего не изменила и ничего не оставила в облаке.",
      "notes": {
        "active_shift": "Смена {{number}} не была закрыта в облаке.",
        "device_out_of_sync": "Станция «{{name}}» не отправила данные в облако после последнего закрытия смены.",
        "text_changed": "{{entity}} {{record}}: в поле «{{field}}» убраны управляющие символы или текст сокращён до допустимой длины.",
        "inn_dropped": "{{entity}} {{record}}: ИНН не из 10 или 12 цифр, не перенесён.",
        "gs1_prefix_dropped": "{{entity}} {{record}}: префикс GS1 «{{value}}» не перенесён.",
        "time_zone_replaced": "Часовой пояс «{{value}}» заменён на Europe/Moscow.",
        "line_renamed": "Линия «{{from}}» переименована в «{{to}}»: имена линий не повторяются.",
        "line_dropped": "Линия без названия не перенесена.",
        "counterparty_dropped": "Контрагент {{record}} не перенесён: {{reason}}.",
        "counterparty_notes_lost": "Заметки контрагентов не переносятся: {{count}}.",
        "template_dropped": "Шаблон {{record}} не перенесён: {{reason}}.",
        "template_default_dropped": "Умолчание шаблона ({{slot}}) не перенесено: шаблон выключен, другого назначения или не охватывает категорию.",
        "product_dropped": "Товар {{record}} не перенесён: {{reason}}.",
        "product_value_cleared": "Товар {{record}}: «{{field}}» вне допустимых пределов, поле очищено.",
        "product_template_dropped": "Товар {{record}}: шаблон по умолчанию не перенесён (шаблон дубликата или его нет).",
        "product_fields_lost": "Не переносится «{{field}}» у товаров: {{count}}.",
        "operator_dropped": "Оператор {{record}} не перенесён: {{reason}}.",
        "badge_dropped": "Бейдж {{record}} не перенесён: {{reason}}.",
        "badges_rehashed": "Бейджей с пересчитанным хешем: {{count}}.",
        "badge_salt_created": "У организации в облаке не было соли бейджей: создана новая.",
        "badges_not_operators": "Бейджи сотрудников без доступа к станции не переносятся: {{count}}.",
        "counterparty_sscc_used": "Смен с SSCC под префиксом контрагента: {{count}}. Автоном выпускает SSCC только под префиксом организации.",
        "planned_shifts_not_moved": "Запланированные смены не переносятся ({{count}}): запланируйте их заново.",
        "sscc_window_does_not_fit": "Окно отката не помещается в префикс {{issuerPrefix}} ({{kind}}): облачный счётчик при откате переводится вручную.",
        "unknown": "Замечание «{{code}}»."
      },
      "entities": {
        "organization": "Организация",
        "counterparties": "Контрагент",
        "templates": "Шаблон",
        "products": "Товар",
        "operators": "Оператор"
      },
      "fields": {
        "name": "название",
        "printName": "название для печати",
        "role": "должность",
        "boxCapacity": "в коробе",
        "palletBoxCapacity": "коробов на паллете",
        "shelfLifeDays": "срок годности",
        "price": "цена",
        "egaisCode": "код ЕГАИС",
        "externalRef": "внешний код",
        "photo": "фото",
        "defaultCounterparty": "контрагент по умолчанию"
      },
      "reasons": {
        "gln": "GLN не из 13 цифр",
        "name": "пустое название",
        "gtin": "GTIN не из 14 цифр",
        "spec_not_object": "макет не объект",
        "spec_too_deep": "макет глубже 64 уровней",
        "spec_too_large": "макет больше 256 КБ",
        "login": "табельный номер не из 3–12 цифр",
        "pin": "хеш PIN не читается автономом",
        "operator": "его оператор не перенесён",
        "code": "код бейджа не из печатных символов ASCII",
        "duplicate": "такой бейдж уже есть"
      },
      "check": "Проверить",
      "import": "Перенести",
      "trialTitle": "Проверка",
      "trialOk": "Проверка пройдена: перенос запишет то, что ниже.",
      "repeated": "Этот файл уже перенесён на площадку: показан итог того переноса.",
      "doneTitle": "Перенос выполнен",
      "doneOk": "Данные облака перенесены. Станции получат их при следующей синхронизации.",
      "afterDeleteFile": "Удалите файл переноса с флешки и с этого ПК: в нём хеши PIN и бейджей.",
      "afterCloudCounters": "Переведите облачные счётчики SSCC на значения таблицы выше, если это ещё не сделано (памятка переключения).",
      "counts": {
        "lines": "Линии",
        "linesValue": "новых {{created}}, уже были {{present}}",
        "counterparties": "Контрагенты",
        "templates": "Шаблоны",
        "templatesValue": "{{templates}}, умолчаний {{defaults}}",
        "products": "Товары",
        "operators": "Операторы",
        "badges": "Бейджи"
      },
      "confirmTitle": "Перенести данные облака?",
      "confirmText": "Товары, шаблоны, контрагенты, операторы с их PIN и бейджами и счётчики будут записаны на площадку. Повторить перенос другим файлом будет нельзя.",
      "failure": {
        "siteNotEmpty": "На площадке уже есть данные ({{entity}}): перенос возможен только на новую площадку.",
        "alreadyImported": "На площадку уже перенесены данные другого файла ({{at}}).",
        "orgGln": "GLN организации на площадке ({{site}}) не совпадает с файлом ({{file}}). Исправьте GLN на странице «Профиль» и повторите.",
        "row": "Автоном не принял строку файла ({{field}}): файл повреждён или сделан другой версией выгрузки."
      },
      "siteEntities": {
        "shifts": "смены",
        "sscc_blocks": "выданные блоки SSCC",
        "category_template_defaults": "умолчания шаблонов категорий",
        "products": "товары",
        "label_templates": "шаблоны",
        "operators": "операторы",
        "counterparties": "контрагенты",
        "unknown": "записи"
      }
    }
  },
```

- [ ] **Step 4: Запуск — проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/cloud-import-page.test.tsx`
Expected: `Tests  7 passed (7)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: `Test Files  69 passed (69)`, `Tests  1760 passed (1760)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `… run lint` и `… run build`
Expected: без ошибок (у `build` — только прежнее предупреждение о размере чанка).

- [ ] **Step 5: Мутации (в `CloudImportPage.tsx`; команда — шаг 4, первый запуск)**

1. `cloudImportRequest(loaded.file, loaded.importId, dryRun)` → `cloudImportRequest(loaded.file, crypto.randomUUID(), dryRun)` — FAIL `shows the file, the counters and the notes, and imports only after a check` и `sends the same import again after a lost answer`.
2. Удалить строку `    await queryClient.resetQueries({ queryKey: ["office"] });` — FAIL `shows the file, the counters and the notes, and imports only after a check` (профиль не читается второй раз).
3. `disabled={send.isPending || trial === null}` → `disabled={send.isPending}` — FAIL `shows the file, …` (кнопка «Перенести» доступна до проверки).

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check apps/standalone/src/office/import apps/standalone/src/office/nav.ts \
  apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/cloud-import-page.test.tsx
git diff --check
git add apps/standalone/src/office/import/import-notes.ts apps/standalone/src/office/import/CloudImportPage.tsx \
  apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json \
  apps/standalone/test/cloud-import-page.test.tsx
git commit -m "feat(standalone): «Перенос из облака» in the office: the file, a check, the import

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Памятка переключения и отката, `AGENTS.md`, итоговые проверки

Памятка (§8.8–8.10) описывает пробный прогон, границу смен, выгрузку, перевод облачных счётчиков в кабинете за окно, перенос и откат — с командами инструмента и проверками; названия разделов кабинета помечены «сверить на месте». `AGENTS.md` получает раздел «Cloud import»: три части, правила формата, маршрута и страницы и то, что не проверено. Это последняя задача, потому что обе опираются на имена задач 3, 6 и 8.

**Files:**

- Create: `docs/runbooks/standalone-cloud-cutover.md`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: CLI (задача 3), маршрут (задача 6), страница (задача 8).
- Produces: документы.

- [ ] **Step 1: Памятка и раздел `AGENTS.md`**

Создать `docs/runbooks/standalone-cloud-cutover.md`:

<!-- prettier-ignore -->
````md
# Переключение клиента с облака на «Markiro Автоном»

Памятка к плану ИМП (`docs/superpowers/plans/2026-10-09-standalone-imp-cloud-import.md`) и
разделам 8.6–8.10 спецификации пилота
(`docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`). Её выполняет владелец или
наш инженер; клиент участвует в шагах на площадке.

Файл переноса содержит хеши PIN и бейджей и соль бейджей. Он ходит только на флешке, лежит в
папке, доступной одному пользователю, и удаляется после переноса. Его не пересылают почтой и
мессенджерами и не прикладывают к задачам.

## 0. Что нужно заранее

- Резервная копия облачной базы, проверенная восстановлением, и временный экземпляр Postgres,
  развёрнутый из неё (управляемый Postgres Яндекса: восстановление кластера из копии в новый
  кластер). Переменные libpq этого экземпляра (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` или
  `~/.pgpass`, `PGDATABASE`, `PGSSLMODE=require`) задаются в оболочке, а не в командной строке.
- `tenantId` клиента: `id` его строки в `organization` (виден в SaaS-админке в карточке
  арендатора).
- Node 24, `psql` 16 или новее, эта ветка репозитория.
- Автоном установлен на ПК площадки; связь, принтеры и сканеры проверены на пробной установке,
  которую затем удаляют вместе с базой (спецификация пилота, §8.9, шаг 1).

## 1. Пробный прогон (за несколько дней)

1. Копия базы — любая свежая. Если в ней есть открытая смена или станция без синхронизации,
   выгрузка откажет; для пробы добавьте `--rehearsal`:

   ```sh
   node tools/standalone-export/cli.mjs --tenant <tenantId> --out-dir <папка> --rehearsal
   ```

2. На нашем ПК: новая установка автонома, мастер с реквизитами из сводки выгрузки (название,
   ИНН, GLN, часовой пояс; линии — любые из файла), затем «Сервис → Перенос из облака»:
   выбрать файл, «Проверить», прочитать замечания, «Перенести».
3. Сверить (§8.8): числа записей в итоге с числами в сводке выгрузки; вход оператора прежним PIN
   и бейджем на станции; печать этикетки короба каждым перенесённым шаблоном (кириллица,
   DataMatrix, SSCC) и сравнение с облачной этикеткой; первый SSCC автонома больше последнего
   облачного («SSCC» автонома против колонки «Облако выдало до»).
4. Удалить пробную установку вместе с базой и пробный файл.

## 2. Граница смен (день переключения, лучше перед выходными)

1. В облаке все смены закрыты и выгружены; облачная станция синхронизирована (очередь и
   карантин пусты); в кабинете «SSCC» не показывает блокировку. Файлы ЧЗ и отчёты смен, которые
   понадобятся повторно, выгружены из облака: истории в автономе не будет.
2. Облачная станция остановлена: выход из смены, приложение закрыто. Планировать смены в кабинете
   после выгрузки нельзя.
3. Копия облачной базы, сделанная **после** шагов 1–2, развёрнута во временном экземпляре.

## 3. Выгрузка

```sh
node tools/standalone-export/cli.mjs --tenant <tenantId> --out-dir /Volumes/<флешка>
```

- Код выхода 2 и строки «смена … не закрыта» или «станция … не синхронизирована» — облако не
  чистое: вернитесь к шагу 2. Файл не пишется.
- Сводка называет файл, реквизиты, числа записей, номера смен, по каждому префиксу SSCC — что
  выдало облако, с чего начнёт автоном и **на что перевести облачный счётчик**, и контрольную
  сумму. Сохраните сводку в протоколе переключения (секретов в ней нет).

## 4. Окно отката: перевод облачных счётчиков

Сразу после выгрузки, в кабинете облака, для каждой строки сводки:

- префикс организации — «Настройки» → профиль организации → «Счётчики SSCC»: короба и паллеты
  на значения «облако перевести на»;
- префикс контрагента — «Контрагенты» → карточка → «Счётчики SSCC».

Названия разделов кабинета сверить на месте. Перезасев отзывает блоки облачной станции, поэтому
она уже не напечатает номер из окна автонома. Если строка говорит «окно не помещается», облачный
счётчик при откате переводится вручную выше счётчика автонома (§8.10, вариант «без окна»).

## 5. Перенос в автоном

1. Мастер первого запуска на ПК хоста: реквизиты организации — ровно как в сводке (GLN
   обязательно совпадает: иначе перенос откажет с «GLN не совпадает»), линии — из файла.
2. «Сервис → Перенос из облака» (администратор): выбрать файл с флешки. Проверить реквизиты,
   таблицу SSCC и замечания. «Проверить», затем «Перенести».
3. Проверки: стартовые номера на экране «SSCC» автонома равны колонке «автоном начнёт с» (или
   больше); вход операторов прежним PIN и бейджем; первая смена — короб, паллета, этикетки,
   закрытие, выгрузка XML; загрузка XML в личный кабинет ЧЗ с ПК с интернетом (внешняя
   проверка).
4. Удалить файл с флешки и с ПК.

Если ответ на перенос потерялся (связь, перезапуск), нажмите «Перенести» ещё раз на той же
странице: повтор того же файла возвращает итог уже выполненного переноса. Другой файл после
переноса не принимается.

## 6. Откат (§8.10)

Когда: автоном не печатает, не выгружает, теряет данные или ЧЗ не принимает его XML.

1. Смены автонома закрыть и выгрузить в автономе. Если не выходит, факты остаются в базе хоста
   и копиях для разбора.
2. Облачную станцию запустить снова: она получит новые блоки за окном (шаг 4), повторных SSCC не
   будет. Без окна — сначала вручную перевести облачный счётчик выше `next_serial` автонома по
   каждому префиксу и расширению.
3. Номера смен облака продолжат облачный счётчик; совпадение номеров с автономом допустимо
   (`document_id` у ЧЗ уникален).
4. Каталог и операторов, изменённых в автономе после переключения, перенести в облако вручную:
   обратного переноса нет.

Окно коробов — 1 000 000 номеров: при 2 000 коробах в сутки автоном дойдёт до облачного старта
примерно через 500 дней. До этого облако нужно перевести дальше или вывести из работы.
````

В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```md
## Reference sync
```

заменить на

<!-- prettier-ignore -->
```md
## Cloud import

Plan IMP moves a cloud tenant into a new site (pilot spec §8). Three parts,
tied by one golden file, `proto/fixtures/cloud-export-file.json`:

- `tools/standalone-export` (root `pnpm test:standalone-export`): `export.sql`
  reads one tenant through psql in one read-only REPEATABLE READ transaction
  from a RESTORED COPY of the cloud database (libpq environment, never a
  password argument), and `transform.mjs` turns it into the file. Its
  `payload` passes the host's rules as it stands: what the standalone cannot
  keep is changed or left out there and named in `notes` (the office shows
  them by code). PIN hashes move byte for byte; the tenant's badge salt
  becomes the site's, and a badge whose hash is missing or carries another
  salt is hashed again from its code (trimmed; a code a station cannot read is
  left out), so no badge code ever reaches the file. The SSCC start of each
  prefix and extension is one above the highest serial the cloud handed out
  (counter − 1, any block's end, revoked ones included, and any box's or
  pallet's SSCC), rounded up to the next 10 000; the file's `cutover` names
  the value the cloud's counter moves to (start + 1 000 000 boxes or 100 000
  pallets) for the runbook (`docs/runbooks/standalone-cloud-cutover.md`).
  Shift-number counters move for every month the cloud drew a number in. The
  checksum is SHA-256 of the canonical JSON (sorted keys) of the whole file
  without `checksum`; `src/host/cloud-import.ts` computes the same.
  `test/export-sql.test.mjs` runs only with `STANDALONE_EXPORT_TEST_DATABASE_URL`
  (CI's `verify-api-tests`, after the cloud migrations) and seeds two tenants
  of its own.
- `POST /v1/office/import` (`routes/cloud_import.rs`, administrators, its
  own 32 MiB body limit): `cloud_import::check` refuses any row the office
  routes would refuse, with the request's JSON path (`payload.products.2.gtin14`);
  inside one `begin_write` transaction it re-checks the administrator, answers
  a repeat of the same `importId` with the stored summary (no write, no
  revision, no audit row) and any other import after one with `conflict`
  `already_imported`, refuses a site that holds a shift, an SSCC block, a
  category default, a product, a template of its own, an operator or a
  counterparty (`site_not_empty` with `details.entity`; the wizard's lines
  and stock templates may be there) and an organization whose GLN is not the
  file's (`org_gln`), checks the product groups, and then writes every row at
  one revision and wakes the streams. A file line whose name an active line
  has is kept as the wizard made it (`linesPresent`). The organization's box
  and pallet defaults become the file's when it names them. The site's badge
  salt becomes the file's (no badge exists yet, so nothing breaks; the `site`
  record takes it to stations). SSCC and shift-number counters only move
  forward. `dryRun` runs all of it and rolls back: no revision, no wake, no
  audit row. The audit row `import.cloud` (target `site`/`1`, details
  `importId`, `exportedAt`, `rehearsal`, `sourceTenantId` and the summary) is
  the import's record: a repeat reads its summary from there, so it must never
  be deleted, and it holds no hash and no salt. `cloud_import_logs.rs`
  (outside the sandbox) walks a refused, a tried, a done and a repeated
  import through the process log.
- «Сервис → Перенос из облака» (`src/office/import/CloudImportPage.tsx`,
  administrators): reads the file (`readCloudExportFile`: JSON, format,
  version, checksum, then the strict schema), shows its organization (and a
  site GLN that differs), the SSCC table, the shift numbers and the notes,
  sends a check (`dryRun`) and only after a passed check the import, with one
  `importId` per file read, so a retry after a lost answer is the same import.
  A done import resets the office's cached data.

Not verified: a real cloud copy and its volume, `psql` on the CI runner, the
file chooser in WebView2 and the import of a large catalog over IPC.

## Reference sync
```

- [ ] **Step 2: Итоговые проверки**

Run: `node_modules/.bin/prettier --check docs/runbooks/standalone-cloud-cutover.md apps/standalone/AGENTS.md tools/standalone-export apps/standalone/src apps/standalone/test apps/standalone/proto/fixtures package.json .github/workflows/ci.yml tools/ci`
Expected: `All matched files use Prettier code style!`

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
Expected: тишина.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: все наборы `ok`, всего 434 теста в 38 строках `test result`.

Run: `pnpm --config.verifyDepsBeforeRun=false test:standalone-export`
Expected: `ℹ tests 28`, `ℹ pass 27`, `ℹ skipped 1`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (и `typecheck`, `lint`, `build`)
Expected: `Test Files  69 passed (69)`, `Tests  1760 passed (1760)`; остальное — без ошибок.

Run: `git diff --check <начало плана>..HEAD` и `git diff --stat <начало плана>..HEAD`
Expected: чисто; изменены только файлы раздела «Файлы».

Run (если есть `graphify-out/graph.json`): `graphify update .`

- [ ] **Step 3: Коммит**

```bash
git add docs/runbooks/standalone-cloud-cutover.md apps/standalone/AGENTS.md
git commit -m "docs(standalone): cloud import — AGENTS and the cut-over runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] Вне песочницы: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked` — 38 строк `test result`, 434 теста; `cargo fmt … -- --check` — чисто. Оболочка (`src-tauri`) не меняется, поэтому `--workspace` не обязателен; если запускать — сначала собрать вебвью (`apps/standalone/AGENTS.md`, «Verification»).
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 69 файлов, 1760 тестов (было 67 файлов, 1744 теста); `typecheck`, `lint`, `build` — без ошибок.
- [ ] `pnpm --config.verifyDepsBeforeRun=false test:standalone-export` — 28 тестов (27 и 1 пропущен); с одноразовой базой облака — 28; `node --test tools/ci/test/*.test.mjs` вне песочницы — 48.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам и `git diff --check` — чисто; `Cargo.toml`, `Cargo.lock`, `pnpm-lock.yaml`, `apps/api`, `apps/station`, `packages/*`, миграции и `src-tauri` не менялись; в `package.json` — одна строка скрипта.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - выгрузка по настоящей копии облачной базы клиента (объём, время, реальные края данных) — нужна копия от владельца (шаг владельца 1); проверено только на засеве теста SQL по схеме миграций облака;
  - `psql` в раннере `verify-api-tests` и сами задания CI — нужен push, он не разрешён; тест SQL в CI не запускался;
  - страница на WebView2: выбор файла `FileDropZone` в окне киоска, чтение файла в несколько МиБ и импорт большого каталога через IPC (тайм-аут запроса оболочки 10 с) — только jsdom и тесты хоста;
  - вход перенесённого оператора прежним PIN и бейджем на станции автонома и печать перенесённым шаблоном — проверено только сверкой хешей на хосте; станция — пробный прогон памятки;
  - перевод облачных счётчиков в кабинете облака (названия разделов, отзыв блоков, `findSeedBlocker`) — ручной шаг памятки;
  - загрузка XML в ЧЗ после переноса — внешняя проверка.

---

## Перенесено

- План ПЛ-Х / владелец (П7 «да»): `historicalCodeHashes` в формате 2 файла, `legacy_code_owners`, отказ `duplicate` с номером облачной смены в приёме `scan` и проверке кода.
- Владелец (П4 «да»): выпуск SSCC под префиксом контрагента (счётчики уже переносятся как полы).
- План УСТ: мастер мог бы заполнять реквизиты и линии из файла переноса (кнопка «Заполнить из файла»), чтобы GLN не набирался вручную; сейчас GLN сверяет маршрут (`org_gln`), а страница предупреждает заранее.
- Окно отката не ограничивает автоном сверху: через ~1 000 000 коробов он дойдёт до облачного старта. Ограничение (счётчик автонома не выше `cloudReseedTo`) — вопрос владельцу после пилота; памятка напоминает.
- Запись `import.cloud` — запись о переносе: если появится срок хранения журнала (план 5), её нужно исключить из очистки.
- Наблюдение при проверке плана: полный прогон Vitest под нагрузкой (параллельная сборка cargo) дважды уронил по два теста — на базе плана (файл не записан) и с кодом плана (`test/template-editor.test.tsx`, «leaving a label template with unsaved changes»); отдельный прогон файла и повторный полный прогон зелёные (69 файлов, 1760 тестов). Задачи плана экран шаблонов не трогают; при повторе стоит сохранить вывод и проверить известный флейк эффектов React в полном прогоне (память проекта: «Vitest effect race harness»).

## Отклонения при исполнении

- **Задача 1** (`cf08ddf07`, ветка `claude/infra-rk`, основа `cfddf8b15`). Ревью — одобрено, Critical 0, Important 0, Minor 5. Модуль `tools/standalone-export/sscc.mjs` с экспортами и сигнатурами брифа; в корневой `package.json` одна строка `test:standalone-export`; зависимости, CI и `proto` не тронуты. Якорей, требовавших адаптации, нет (файлы новые). Сверх брифа:
  - префикс ровно из 9 цифр (`/^\d{9}$/`): пространство 7-значных серийных номеров держится только для 9-значных префиксов (так режут `deriveIssuerPrefix` облака и `validate::issuer_prefix` хоста);
  - расширение только 0 или 1 (иначе 2–9 молча считались бы паллетами);
  - каждое входное число — `null` либо целое в диапазоне (счётчик 0…10^7, остальные 0…10^7−1), иначе `RangeError` с названием поля, префикса и расширения; строка с плохим числом отказывается, даже если её скрывает большая строка того же ключа;
  - несколько строк одного ключа (префикс, расширение) хранят **наибольшее** значение каждого вида вместо перезаписи (бриф мог потерять наибольший блок и повторить SSCC);
  - `maxConsumedThrough` входит в выданный максимум;
  - сообщение об исчерпании добавляет несостоявшийся старт и последний номер (регулярное выражение брифа по-прежнему совпадает); граница: выдано 9 989 999 → старт 9 990 000, `cloudReseedTo` = `null`; выдано 9 990 000 и выше — выгрузка останавливается;
  - `planShiftNumberCounters`: месяц, названный дважды, сохраняет больший счётчик.
  - Тестов 37 (8 брифа + 29). Фикстура `apps/standalone/proto/fixtures/sscc-serials.json`: контрольная цифра пересчитана независимо, наибольший номер = `SERIAL_CAPACITY - 1`; `@markiro/domain` (`buildSscc`, `isValidSscc`, `ssccSerialCapacity`) подтверждает каждый случай, тест **явно пропускается**, если домен не собран. Мутантов 64, все убиты; один неверный тест автора исправлен (счётчик 9 500 000 даёт старт 9 500 000).
  - Ревью (10 мутантов ревьюера убиты) оставило обязательные добавки m1–m5 (`imp-minors.md`); все исполнены — m1–m3 в задаче 2, m4–m5 в задаче 3:
    - (m1) непрочитанный счётчик номеров смен с `lastSeq > 0` останавливает выгрузку `ExportError("shift_counter_unreadable", …)`; задача 3 сверяет `max(number_seq)` по `month_key` со счётчиками;
    - (m2) `RangeError` задачи 1 — код `sscc_input_invalid`, `sscc_exhausted` остаётся для простого `Error`;
    - (m3) проверка окон отката в `windowOf` (`Number.isSafeInteger(w) && w > 0`, иначе `RangeError`);
    - (m4) межарендаторная проверка префиксов — читающая, в SQL выгрузки;
    - (m5) `affected.mjs` запускает `test:standalone-export` при изменении `sscc-serials.json`; `catch {}` теста домена сужен до `ERR_MODULE_NOT_FOUND`; CI собирает домен до теста.
  - Шаг `pnpm test:standalone-export` в `standalone-windows-build` добавлен ещё итоговой волной потока инфраструктуры (план РК, M5); задача 3 его оставила и добавила шаги в `verify-static` и `verify-api-tests`.
- **Возобновление.** Задача 2 останавливалась (`NEEDS_CONTEXT`) до единой правки: бриф переносит проверочные данные учётных данных, а распоряжение контроллера требовало остановиться на таких полях. 2026-10-11 контроллер принял вариант А (`OWNER-DECISIONS.md`, «DECISIONS 2026-10-11»; владелец может переиграть): файл несёт `payload.operators[].pinPhc`, `payload.badges[].badgePhc` и `payload.badgeSalt`; открытые коды бейджей инструмент читает из копии только для пере-хеширования и в файл не пишет; ни хеш, ни соль, ни код не попадают в журнал, сообщения, примечания и запись аудита. Файл переноса — учётные данные (памятка, §0: права только владельца, флешка владельца, удаление после импорта, один файл — одна площадка). Задачи 2–9 исполнены на ветке `claude/imp-cloud` (основа `2c726efba`, последний коммит задач `76f6adc28`); ревью по задачам — только у задач 1 и 6, остальные прошли итоговое ревью всей части.
- **Задача 2.**
  - `2902c3849`: `phc.mjs`, `canonical.mjs`, `transform.mjs`, `test/fixtures/raw-cloud.json`, эталон `apps/standalone/proto/fixtures/cloud-export-file.json`. Тело `transform.mjs` извлечено из брифа программно, добавки наложены поверх.
  - m1 шире брифа: остановку даёт любая строка счётчика, кроме `lastSeq === 0`, которую не перенёс `planShiftNumberCounters` (плохой ключ, строка, `null`, дробный или отрицательный `lastSeq`, мусорная строка рядом с верной того же ключа); сообщение называет ключи месяцев и счёт.
  - Тест «отказ не называет ни хеша, ни соли, ни кода» по шести кодам отказа; в тексте файла и эталона нет кодов бейджей и ключей `badgeCode`/`badgeHash`.
  - Тестов 89 вместо 22 брифа (`sscc` 38, `transform` 51). Мутантов 302: 288 убиты сразу, 11 — после новых тестов, 3 эквивалентны.
  - Права 0600 и предупреждение CLI о хешах — в задаче 3 (владелец `cli.mjs`).
- **Задача 3.**
  - `a7f32d9de`: `export.sql`, `cli.mjs`, засев и очистка облака, тесты, `affected.mjs`, `ci.yml`. `package.json` не менялся: строка `test:standalone-export` есть с задачи 1.
  - Сверх плана: остановка `shift_counter_behind` (месяц со сменами дальше счётчика или без счётчика, по `shiftNumberMaxima`), и при `--rehearsal` тоже — в плане её не было.
  - m4 сделана слабее, чем просила: `otherTenantsSscc` — только предупреждение в stderr («номера могут повториться», если чужой максимум не ниже старта автонома), в файл и на стартовые номера не идёт, чтобы эталон не менялся. Усилено волной итогового ревью (I2).
  - Сверх плана: `assertRawShape` (`export_output_invalid` вместо `TypeError`); файл `wx` с правами 0600; `--help` с правилом для Windows; предупреждение о хешах в stderr после каждого файла; пароль psql не попадает в argv; `export-sql-static.test.mjs` (ровно три оператора, `READ ONLY`, ни одной записи); живой тест доказывает `READ ONLY` и `REPEATABLE READ`; тест `workflow.test.mjs` закрепляет шаги `ci.yml`.
  - Тестов инструмента 108 вместо 28, tools/ci 57 вместо 48. Мутантов `export.sql` 66: 14 выжили в первом прогоне, все убиты после усиления засева.
- **Задача 4.**
  - `48e2948b0`: `proto/src/cloud_import.rs`. Запрос строгий на каждом уровне (`deny_unknown_fields`), итог терпимый; `pin_phc`, `badge_phc`, `badge_salt` — `Secret`, производный `Debug` печатает `Secret(***)`.
  - Якорь `lib.rs`: модуль вставлен между `backup` и `pairing`. Комментарий модуля не ссылается на несуществующую фикстуру `cloud-import-request.json`: запрос строится из эталона.
  - Тестов 11 вместо 4; мутантов 58, все убиты (один — ошибкой компиляции).
  - Добавлено к задачам 5 и 6 (`imp-minors.md`): хост не пишет запрос в журнал и аудит; `badgeSalt` нет или `null` — соль площадки остаётся.
- **Задача 5.**
  - `e4a4bd3da`: `host/src/cloud_import.rs::check`; у структур с хешами нет `Debug`; `clean_text` в `validate.rs` стал публичным.
  - Исправлен дефект брифа: `is_month_key` резал `&text[..3]` по байтам, и ключ с символом на границе третьего байта ронял поток обработчика. Теперь `text.get(..3)` и побайтовая проверка цифр.
  - Тестов 22 вместо 8; мутантов 84, один эквивалентный (канонический пересчёт соли).
  - Хост не требует счётчика собственного префикса организации и принимает файл с меньшим стартом: защита — контрольная сумма и счётчики только вперёд (см. C1 итогового ревью).
- **Задача 6.**
  - `638abdc07`: маршрут как в брифе, `DefaultBodyLimit` 32 МиБ только на нём. Якоря `server.rs` больше нет — маршрут вставлен перед `/v1/office/users`.
  - Сверх плана: матрица доступа (401 без офисной сессии своего устройства); сбой в середине записи (триггер) откатывает всё; соль `null` или своя не пишет записи `site`; обход `no_secrets_in_logs.rs` (вне списка файлов брифа) закрепляет отсутствие `tracing::` в обоих модулях импорта.
  - Ревью: Critical 0, Important 1, Minor 6. Важное — 15 из 17 мутантов привязки значений к столбцам выживали.
  - Исправление `ef91b772b`: тест «каждое поле файла попадает в свою колонку» и тест умолчаний категорий с разными группами; собственный извлекатель `AdminImport` — сессия и роль администратора до чтения тела, нечитаемое тело получает фиксированный текст без значений; закреплены `rev` поднятого счётчика SSCC и ответ сухого прогона уже сделанного переноса (`dryRun: false`, `repeated: true`). Minor 2 (импорт только с ПК хоста) — вопрос владельцу, Minor 6 (второй хост, пробный файл) — в памятку.
  - Тестов `cloud_import` 20 и `cloud_import_logs` 1 вместо 11 + 1.
- **Задача 7.**
  - `44c909363`, после слияния интеграции `45835828e` (эталоны форм `26572c386`; устаревший `packages/domain/dist` уронил три теста `forms-parity`, пересборка домена их вернула).
  - Сверх плана: `MAX_CLOUD_EXPORT_BYTES` (32 МиБ) и `readCloudExportBlob` — размер проверяется до чтения; превышение — проблема `format`, нового слова нет; отказ формы несёт `path` первой ошибки Zod, без значения.
  - Контрольная сумма сверяется с `canonical.mjs` инструмента; паритет Zod с `proto`: удаление любого ключа эталона и лишний ключ на любом уровне отказываются.
  - Якорь `api.ts`: `importFromCloud` вставлен после `updateTemplateDefaults`. Тестов 28 вместо 9.
- **Задача 8.**
  - `b75a3c30e`. Разобранный файл живёт только в `useRef`, в состоянии — представление без хешей. Запрос идёт через `useOfficeSession().call`, а не `useOfficeMutation`, как в брифе: кэш мутаций react-query держал бы запрос с хешами. Файл сбрасывается после успеха, при выборе другого, по новой кнопке «Убрать файл» и при уходе со страницы; исправимый отказ оставляет его для повтора.
  - `importId` создаётся один раз на чтение файла, а не на запрос: повтор после потерянного ответа получает `repeated`.
  - Сверх плана: защита от двойного нажатия (400 мс после открытия подтверждения), счёты проверки в подтверждении, строка для пробного файла.
  - Найдены и исправлены: фокус после импорта уходил в никуда (перенесён в пассивный `useEffect`); предупреждение act в тесте пробного файла.
  - Якоря: пункт меню и маршрут — после `backups`; классов `standalone-actions` нет, взяты `standalone-form__actions` и `office-note`; доступ — `OFFICE_NAV` и `RequireRole`. Тестов 25 вместо 7; мутантов 66, все убиты.
- **Задача 9.**
  - `76f6adc28`. Памятка `docs/runbooks/standalone-cloud-cutover.md` написана для владельца заново (черновик брифа — каркас): файл — учётные данные (§0), заморозка облака до копии (§3), коды выхода и остановки (§4), перевод облачных счётчиков (§5; названия разделов кабинета — «сверить на месте»), импорт и отказы (§6), откат (§8), вопросы владельцу (§9.1), непроверенное (§9.2).
  - Раздел спецификации — §31 «Уточнения плана ИМП»: §25–§30 заняты другими потоками.
  - `docs/runbooks/standalone-install.md` не было в списке файлов, и «перенос отложен» там остался — исправлено волной итогового ревью.
- **Эталонный файл и контрольные суммы.**
  - Задача 2 воспроизвела контрольную сумму плана `sha256:9716b9df…45c5` байт в байт; sha256 самого файла (`68c3d36a…`) в задачах 3–9 не менялся. Задача 3 добавила в `raw-cloud.json` только ключи `otherTenantsSscc` и `shiftNumberMaxima`.
  - `a2a77521d`: `sha256:f679947f…ea0e` — два новых примечания (`template_dropped` с причиной `pallet_sheet`, `pallet_sheet_defaults_lost` со счётом 2), примечаний 26 вместо 24; payload не изменился. `raw-cloud.json` перегенерирован из вывода живого SQL (ключ `format`, строка листа, `palletSheetDefaults: 2`).
  - `15dfa2473`: итоговая `sha256:99628cca…469a` — строка пола `460999900/0` для старого короба без счётчика и блока (владелец `unknown`, выдано 777, старт 10 000, откат 1 010 000). Изменились `cloud-import-summary.json` и счёты в тестах `proto` и хоста (4 счётчика).
  - Оба раза эталон собран `buildExportFile` инструмента и prettier, разница просмотрена; закрепления в Vitest и `cli.test.mjs` обновлены.
- **Счёт тестов.** Числа плана (434 теста хоста и `proto` в 38 строках, Vitest 69 файлов и 1760 тестов, выгрузка 28, tools/ci 48) — другой основы.
  - После волны правок: инструмент 120 (с одноразовой базой все прошли), tools/ci 57, Vitest 150 файлов и 4663 теста, `cargo test --workspace` 1180 в 75 строках; хост `cloud_import` 21, `cloud_import_rules` 23, `proto` `cloud_import` 11.
  - После слияния с интеграцией: Vitest 161 файл и 4950 тестов, инструмент 120 (119 и 1 пропуск без базы), tools/ci 57, `cargo test --workspace` 1301 в 78 строках.
- **Итоговое ревью** (`76f6adc28`, одноразовый Postgres 17 с миграциями облака до 0185).
  - Critical 1, Important 4, Minor 9:
    - C1 — нет строки переключения для расширения префикса организации, под которым облако не выдавало (обычно паллеты): откат по памятке повторил бы SSCC;
    - I1 — А4-листы паллет облака (`pallet_sheet_v2`, миграция 0183) переносились как термошаблоны паллет, хост их принимал, станция отказала бы в смене;
    - I2 — чужой арендатор под тем же префиксом давал только строку stderr с выходом 0 и был невидим, если у этого арендатора нет строк под префиксом;
    - I3 — `standalone-install.md` по-прежнему говорил «перенос отложен»;
    - I4 — ничто не мешало импортировать пробный или старый файл в боевую площадку;
    - выжили мутанты M11 (конец чужого блока) и M14 (граница счётчика «только вперёд»).
  - Волна из пяти коммитов:
    - `a2a77521d` (C1, I1): обе строки префикса организации всегда; `planSsccCounters` требует `organizationPrefix` (`null` — только в модульных тестах); `export.sql` читает `t.format` и счёт `palletSheetDefaults` напрямую, без `to_jsonb` (копия без столбца останавливает psql); листы и неизвестный формат отбрасываются с примечанием; сверх ревью — хост отказывает шаблону с `spec.kind == "pallet_sheet"`;
    - `15dfa2473` (I2, m4, M11): префиксы организации и контрагентов в `prefixes`, `ssccPrinted` без фильтра; любой чужой номер под префиксом организации останавливает выгрузку `sscc_prefix_shared` (выход 2), и при `--rehearsal`, кроме `--accept-shared-prefix` (тогда примечание в файле); под префиксом контрагента — строка «Справка»; другой арендатор засева перенесён на префикс контрагента, чтобы эталон оставался обычной выгрузкой;
    - `588ec48fb` (m1, m2): файл появляется целиком или никак — временный `.partial` (`wx`, 0600, fsync), `linkSync` без перезаписи, проверенное переименование на ФС без жёстких ссылок; `--out-dir` обязателен; `.gitignore` для `markiro-cloud-export-*.json`;
    - `efc0f46f2` (I4, M14): пробный файл импортируется только после флажка «Это пробная площадка: она будет удалена до переключения»; предупреждение о файле старше 12 ч; тест хоста на счётчик, равный старту файла и на единицу выше;
    - `9071ae4d8` (I3, m5, m6, m8): `standalone-install.md` ссылается на памятку; в памятке — пустое место логотипа, одноимённые копии типовых шаблонов, `validation_failed` по группе; §31 и `AGENTS.md`.
  - Не сделано: m7 (два приведения типа в `cloud-import.ts`).
  - Открыто владельцу: `POST /v1/office/import` принимает любую офисную сессию администратора (и на ТСД), а не только с ПК хоста — по умолчанию оставлено, памятка §9.1.1; хост по-прежнему принимает `rehearsal: true`, защита только на странице (§9.1.2); срок нетронутого облака после переключения (неделя — рекомендация к П8, ответа нет).
  - Запасной путь записи на FAT/exFAT проверен только внедрёнными сбоями ФС; задания CI не запускались (push не разрешён).
- **Слияние с интеграцией (`4843a1ae0`).** Основа `ca6c6598a`; два конфликта решены объединением:
  - `host/tests/no_secrets_in_logs.rs` — комментарий объединён (партия склада СКЛ и импорт ИМП), `facts_files == 18`, `import_files == 2`;
  - спецификация пилота — разделы по порядку 24, 26, 30, 31. Фраза §31 о перенумерации при слиянии и правке ссылок в памятке и `AGENTS.md` устарела (номер уже окончательный) и оставлена как есть; исправлена следующим слиянием, ХП и ОЧ (`0ca4d78d0`).
  - Без конфликтов: `AGENTS.md`, `ru.json` (ключи уникальны), `routes/mod.rs`, `server.rs`, `lib.rs` `proto`, `api.ts`, `office.tsx`, `ci.yml`, `affected.mjs`. Windows, оборудование, браузер и живой тест Postgres не проверялись.
