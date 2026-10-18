# Отчёт: план 1c3, задача 1 — синхронизация справочников

## Что реализовано

1. `HostApi.getChanges: (since: number) => Promise<ChangesResponse>` в
   `apps/standalone/src/host/api.ts` — `GET /v1/changes?since=<since>` без
   `officeToken` (только ключ устройства, без офисной сессии).
2. `apps/standalone/src/local/reference-sync.ts`:
   - `ENTITY_SET = "org_profile,site,lines"`;
   - `type SyncResult = { kind: "synced"; rev: number } | { kind: "other_host" }`;
   - `interface SyncOptions { changes; local; hostId }`;
   - `syncReferences(options: SyncOptions): Promise<SyncResult>` — читает
     `sync_state`, тянет `GET /v1/changes` порциями от последней применённой
     ревизии до `hasMore = false`, применяет каждую порцию одной
     `local_transaction` (условное удаление по надгробиям + `json_each`-upsert
     на сущность + запись ревизии), проверяет каждую живую запись Zod-схемой
     до применения порции, стартует с нуля при смене хоста/набора сущностей/
     откате хоста (не больше одного отката за прогон), останавливается с
     `other_host`, если лента отвечает от другого хоста;
   - `interface SyncScheduler { trigger; stop }`, `createSyncScheduler(run)` —
     один прогон одновременно, триггеры во время прогона дают ровно один
     повторный прогон, неудачный прогон ждёт следующего триггера.
3. `apps/standalone/test/support/office.tsx`: `getChanges` добавлен в
   `fakeHostApi` (падает как "unexpected", если тест его не подменил).
4. Документация: раздел «Reference sync» и дополнение раздела «Change feed» в
   `apps/standalone/AGENTS.md`; три новых пункта §5.4 в
   `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.

Код `src/local/reference-sync.ts` и правки в `api.ts`/`office.tsx` взяты из
брифа дословно (раздел «Step 3»); тест — из брифа дословно (раздел «Step 1»).
Отклонений от брифа не потребовалось (см. «Отклонения» ниже — их нет).

## TDD: RED и GREEN

### RED

Команда:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/api.test.ts
```

Вывод (после создания `test/reference-sync.test.ts` и правки фрагмента в
`test/api.test.ts`, до правок `src/host/api.ts` и до создания
`src/local/reference-sync.ts`):

```
 ❯ test/reference-sync.test.ts (0 test)
 ❯ test/api.test.ts (13 tests | 1 failed) 7ms
     × reads the change feed with the device key only, no office session 1ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/reference-sync.test.ts [ test/reference-sync.test.ts ]
Error: Failed to resolve import "../src/local/reference-sync.js" from "test/reference-sync.test.ts". Does the file exist?

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/api.test.ts > HostApi office endpoints > reads the change feed with the device key only, no office session
TypeError: api.getChanges is not a function

 Test Files  2 failed (2)
      Tests  1 failed | 12 passed (13)
```

Matches the brief's expected RED exactly: `reference-sync.test.ts` fails to
load (module missing), `api.test.ts` fails on `api.getChanges is not a
function`.

### GREEN

Same command, after implementing `HostApi.getChanges`,
`src/local/reference-sync.ts` and the `fakeHostApi` entry:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/api.test.ts
```

```
 Test Files  2 passed (2)
      Tests  27 passed (27)
```

27 = 14 (`reference-sync.test.ts`) + 13 (`api.test.ts`, the 12 pre-existing
plus the new `getChanges` case) — matches the brief's expected count exactly.

## Все команды проверки и результаты

1. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/api.test.ts`
   → RED, then GREEN as above.
2. `node_modules/.bin/prettier --write <7 changed files>` → all reported
   `(unchanged)` — the brief's code and doc fragments were already in
   Prettier's style.
3. `node_modules/.bin/prettier --check <7 changed files>` → `All matched
files use Prettier code style!`
4. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
   → `Test Files  22 passed (22)` / `Tests  324 passed (324)`. Baseline was
   21 files / 309 tests; +1 file (`reference-sync.test.ts`) and +15 tests
   (14 new + 1 new case in `api.test.ts`) = 22 / 324, exactly as expected.
5. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
   → `tsc -p tsconfig.json --noEmit`, no output, exit 0.
6. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
   → `eslint . --ignore-pattern 'target/**' --ignore-pattern 'src-tauri/gen/**' --ignore-pattern '.markiro-host/**'`,
   no output, exit 0.
7. `git diff --check` (both before staging and `git diff --check HEAD~1 HEAD`
   after committing) → exit 0, no output.
8. Manual scan of the new module for `any`, `!` non-null assertions and
   broad casts (`grep -nE '\bany\b|! *[;)\]]|as unknown as|as any'`) → clean.

No database-backed or infrastructure-dependent tests are in scope for this
task; `@markiro/standalone` tests run entirely on `node:sqlite` and mocks, so
no `DATABASE_URL`-gated skips apply here.

## Файлы

Изменено/создано (ровно список брифа, что подтверждает `git show --stat`):

- `apps/standalone/src/local/reference-sync.ts` (new)
- `apps/standalone/test/reference-sync.test.ts` (new)
- `apps/standalone/src/host/api.ts` (modified: `getChanges` import, type, interface member, implementation)
- `apps/standalone/test/support/office.tsx` (modified: `getChanges` in `fakeHostApi`)
- `apps/standalone/test/api.test.ts` (modified: new `getChanges` case)
- `apps/standalone/AGENTS.md` (modified: "Change feed" addendum + new "Reference sync" section)
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (modified: three new §5.4 bullets)

## Отклонения при исполнении

Нет. Код брифа скомпилировался, прошёл strict TypeScript
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint и Prettier
без единой правки. Тесты брифа прошли как написаны, без ослабления
утверждений.

Единственная не строго механическая часть — пунктуация в §5.4 спецификации:
последний прежний пункт («…устройство подключено к другому хосту.») кончался
точкой как последний пункт списка; я заменил точку на «;», чтобы список
продолжился тремя новыми пунктами (третий из них теперь кончается точкой),
сохранив стиль пунктуации остальных списков документа (`;` между пунктами,
`.` в конце). Смысла это не меняет.

## Самопроверка

- Прочитал бриф, ограничения плана и оба `AGENTS.md` (корневой и
  `apps/standalone`) перед правками.
- Сверил интерфейсы из «Facts» задания с фактическим кодом плана 1c2:
  `LocalExecutor`/`LocalStatement` (`src/local/executor.ts`),
  `changesResponseSchema`/`orgRecordSchema`/`siteRecordSchema`/
  `lineRecordSchema` (`src/host/protocol.ts`), `openLocalDb()`
  (`test/support/local-db.ts`), `HOST_ID` (`test/support/fixtures.ts`) — все
  совпадают с описанием в брифе, без переименований со стороны 1c2.
- Убедился, что фикстура `proto/fixtures/changes-response.json` уже
  существует (из плана 1c1: `rev: 42, hasMore: false`) и подходит новому
  тесту `api.test.ts` без изменений.
- Проверил каждый сценарий `reference-sync.test.ts` вручную против кода
  (полный сначала синхрон, постраничная лента, повторное применение той же
  порции — включая точный подсчёт `changes()` по каждому statement, удаление
  по надгробиям с защитой от отката, двойной откат хоста → ошибка, смена
  хоста → немедленная очистка, смена набора сущностей → очистка только с
  первой новой порции, порченая запись → ничего не применяется, неизвестная
  сущность → пропускается) — до запуска, чтобы TDD-эффект был осмысленным, а
  не «код списан, тесты сами прошли».
- Проверил, что во всех write-транзакциях батч не превышает 32 операторов
  (максимум сегодня — 11: 3×2 на сущность + WRITE_STATE + WIPE из 4), и что ни
  один SQL-текст не содержит запрещённых слов/паттернов из
  `test/support/local-db.ts` (`CREATE`, `DROP`, `ALTER`, `;` внутри тела,
  `--`, `/*`, ведущий `END`).
- Стадировал ровно те 7 файлов, что перечислены в брифе; `git status`
  подтвердил отсутствие посторонних изменений до коммита.
- Проверил трейлер коммита `git log -1 --format=%B` — совпадает дословно с
  требованием и с трейлером всех пяти предыдущих коммитов этой ветки/плана.
- Не трогал `apps/station`, Rust или `pnpm-lock.yaml`; не использовал
  `git stash`, `pnpm install`/`add`.

## Итог

Задача 1 плана 1c3 выполнена полностью: модуль синхронизации справочников,
`HostApi.getChanges`, тесты, документация. Все проверки зелёные. Готово для
следующих задач плана (3–5), которые подключат `syncReferences` и
`createSyncScheduler` к оболочке через `connection.watch`.

## Fix round 1

Ревьюер нашёл настоящую гонку при переподключении во время синхронизации и
несколько дешёвых укреплений. Все пять пунктов исправлены в
`apps/standalone/src/local/reference-sync.ts` и покрыты тестами в
`apps/standalone/test/reference-sync.test.ts`; коммит `66088d759`.

### Что изменено

1. **Гонка переподключения.** Раньше немедленная очистка при смене хоста
   (`stored.hostId !== hostId`) удаляла `sync_state` и ничего не писала
   взамен; отложенная страница устаревшего хоста X, чей запрос был в полёте
   (до 10 с), могла прийти уже после того, как новый прогон для хоста Y
   очистил и заполнил копии, и записать свои более высокие ревизии поверх
   ревизий Y — `ref_org`/`ref_site` используют один и тот же `id = '1'` на
   любом хосте, так что `excluded.rev > rev` пропустил бы устаревшие данные X.
   Исправлено:
   - немедленная очистка теперь в той же транзакции пишет `sync_state.host_id
= <новый hostId>` без `last_rev` (`WRITE_HOST_ID`) — копии по-прежнему
     читаются как несинхронизированные;
   - каждая порция теперь начинается со статичного стража `hostGuard`:
     `UPDATE sync_state SET value = value WHERE key = 'host_id' AND value <>
?` с `expectedChanges: 0`, привязанным к `hostId` этого прогона. Если
     `host_id` уже сменился, страж находит одну строку, `changes_mismatch`
     откатывает всю порцию; если `host_id` не менялся или строки ещё нет
     (первая синхронизация), страж проходит с 0 изменений. Страж стоит первым
     в порции — до `WIPE`, потому что `DELETE FROM sync_state` внутри той же
     порции стёр бы строку `host_id`, которую страж читает.
2. **Защита от отсутствия прогресса.** Добавлена проверка `page.hasMore &&
page.rev <= since` сразу после обработки отката хоста (`page.rev < since`
   уже обработан и делает `continue`, так что к этой проверке `rev >= since`
   уже гарантирован, то есть остаётся ровно случай `rev === since`) — лента,
   утверждающая «есть ещё» без продвижения ревизии, теперь останавливает
   синхронизацию ошибкой вместо бесконечного цикла.
3. **Контракт планировщика.** JSDoc `createSyncScheduler` теперь явно
   говорит, что `run` обязан сам сообщать о своей ошибке: планировщик
   гарантирует только один прогон за раз плюс один отложенный повтор, и
   ничего — про исход.
4. **`ENTITY_SET` из карты сущностей.** `ENTITY_SET` теперь
   `[...ENTITIES.keys()].join(",")` вместо отдельной строковой константы —
   переставлен после определения `ENTITIES`. Значение не изменилось
   (`"org_profile,site,lines"`), это закреплено тестом. Предложение в
   `AGENTS.md` про ручное обновление `ENTITIES`/`ENTITY_SET` переписано под
   вывод одного из другого.
5. **Тестовые пробелы.** Добавлены: обновление существующей записи `ref_org`
   и `ref_site` новой ревизией с изменёнными полями (были только вставки и
   обновление `ref_lines`); тесты `other_host` и «нечитаемая запись» теперь
   стартуют от уже синхронизированных копий со сменённым `entity_set`
   (взведённая отложенная очистка) и проверяют, что копии остаются нетронуты
   — раньше оба теста стартовали с пустой базы, где преждевременная очистка
   была бы неотличима от корректного поведения; `stop()` во время прогона с
   уже поставленным в очередь триггером — ни одного лишнего прогона после
   остановки.

### RED

**Пункт 1 (гонка), обязательный по заданию.** Временно откатил обе правки
кода (`WRITE_HOST_ID` → `WIPE` без записи `host_id`; батч без `hostGuard`) и
прогнал только новый тест:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "rejects a stale in-flight page"
```

```
 ❯ test/reference-sync.test.ts (20 tests | 1 failed | 19 skipped) 60ms
     × rejects a stale in-flight page for the old host after a re-pair wiped its copies 60ms

 FAIL  test/reference-sync.test.ts > reference sync > rejects a stale in-flight page for the old host after a re-pair wiped its copies
Error: expected A's stale sync to fail
 ❯ error test/reference-sync.test.ts:391:15
```

Без гварда прогон A действительно завершался успешно (`resolves`, не
`rejects`) — то есть без стража устаревшая страница X реально перезаписала
бы профиль организации хоста Y, ровно та порча, которую описал ревьюер.

**Пункт 2 (защита от отсутствия прогресса), для полноты.** Временно убрал
проверку `page.hasMore && page.rev <= since` и прогнал только этот тест
(`-t "claims more pages without advancing"`, `--testTimeout=2000`): прогон
не уложился и в 30 с — фоновая задача была принудительно остановлена
(`TaskStop`), файл вывода остался пустым. Это сильнее, чем просто упавший
таймаут: тесная петля `await changes(since)` / `await
local.transaction(...)`, где оба вызова разрешаются немедленно (без
реального I/O), не отдаёт очередь микрозадач макрозадачам — вызов
`setTimeout`, на котором держится `--testTimeout` у Vitest, так и не
получает слот, и процесс виснет, а не просто медленно проваливается. Это
прямое подтверждение формулировки ревьюера («цикл забирал бы и коммитил
вечно, а планировщик никогда не запустился бы снова») — без защиты баг не
просто «падает по таймауту», а вешает раннер целиком. После восстановления
защиты этот же тест проходит менее чем за 130 мс в составе всего файла.

Пункты 3–5 — это контрактная документация (3), безопасный рефакторинг с
сохранением значения (4) и усиление покрытия уже корректного поведения (5);
для них отдельного падения до правки не показывал (пункт 4 не меняет
поведение, пункт 5 проверяет то, что уже работало правильно — вести RED
для них означало бы либо тривиальный «зелёный уже» результат, либо
намеренную порчу кода ради красной галочки, что не было целью).

### GREEN

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts
```

```
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

20 = было 14 + 6 новых (`ENTITY_SET`, обновление `ref_org`, обновление
`ref_site`, защита от отсутствия прогресса, гонка переподключения,
`stop()` с отложенным триггером); два теста (`other_host`, «нечитаемая
запись») изменены на месте, без изменения общего числа тестов.

### Все команды проверки и результаты

1. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
   → `Test Files  22 passed (22)` / `Tests  330 passed (330)`. Было 324;
   +6 новых тестов в `reference-sync.test.ts`, без новых файлов.
2. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
   → `tsc -p tsconfig.json --noEmit`, чисто.
3. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
   → чисто.
4. `node_modules/.bin/prettier --check apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/AGENTS.md`
   → `All matched files use Prettier code style!`.
5. `git diff --check` (до коммита) и `git diff --check HEAD~1 HEAD` (после)
   → чисто, без вывода.

### Файлы (раунд правок)

- `apps/standalone/src/local/reference-sync.ts` — `WRITE_HOST_ID`,
  `hostGuard`, защита от отсутствия прогресса, `ENTITY_SET` из `ENTITIES`,
  JSDoc `createSyncScheduler`.
- `apps/standalone/test/reference-sync.test.ts` — 6 новых тестов, 2 теста
  изменены на месте (с сохранением их прежних утверждений `resolves`/
  `rejects`, но с более сильной проверкой состояния копий), 2 существующих
  утверждения обновлены под новое (запрошенное) поведение (см. «Отклонения»).
- `apps/standalone/AGENTS.md` — предложение про `ENTITIES`/`ENTITY_SET`
  переписано; раздел «Reference sync» дополнен описанием немедленной записи
  `host_id`, `hostGuard`, защиты от отсутствия прогресса и обязанности `run`
  сообщать о своей ошибке.

### Отклонения (раунд правок)

Ни одного отклонения от заданных в задаче SQL/логики/текстов. Единственное,
что пришлось скорректировать сверх буквального текста задания — два
СУЩЕСТВУЮЩИХ утверждения, которые перестали быть верными как прямое и
ожидаемое следствие запрошенных изменений (a) и (b), а не как побочная
порча:

- «wipes the copies of a pairing with another host before anything else»:
  `expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] })`
  после немедленной очистки стал неверным, поскольку немедленная очистка
  теперь (по прямому требованию пункта 1a) сама пишет строку `host_id` в той
  же транзакции. Заменил на `state: [{ key: "host_id", value: HOST_ID }]` —
  это ровно то, что остаётся после `WIPE` + `WRITE_HOST_ID`, и комментарий
  рядом объясняет, зачем эта строка теперь там.
- «applies the same page again without changing a record»: ожидание батча
  `[[0, 0, 0, 3]]` стало `[[0, 0, 0, 0, 3]]`, так как `hostGuard` (по прямому
  требованию пункта 1b) теперь первым статичным элементом каждой порции —
  добавленный `0` это его 0 изменений (страж прошёл, `host_id` не менялся).

Оба изменения — это исправление тестов под явно запрошенное поведение, а не
ослабление: сила проверки (что именно в базе, сколько операторов в батче)
сохранена, изменились только конкретные ожидаемые значения, следующие из
кода задания.

### Самопроверка (раунд правок)

- Прогнал каждый новый тест вручную по коду до его добавления, включая
  пошаговый разбор гонки (readState → немедленная очистка B → `resolveA` →
  `hostGuard` находит несовпадение → `changes_mismatch` → откат целиком,
  включая ещё не выполненные statements той же порции).
  Пример из теста гонки, где именно ловится несовпадение:
  `UPDATE sync_state SET value = value WHERE key = 'host_id' AND value <> ?`
  с `expectedChanges: 0` — первый оператор порции A, так что откат происходит
  до того, как строка `ref_org` вообще пробуется обновить.
- Явно перепроверил порядок `hostGuard` относительно `WIPE` внутри одной
  порции: страж обязан идти до `DELETE FROM sync_state`, иначе `WIPE` уже
  стёр бы строку `host_id`, которую страж должен прочитать, и страж всегда
  проходил бы вхолостую (0 строк — потому что удалять уже нечего).
  Убедился, что тесты с взведённой отложенной очисткой
  (`entity_set`-сценарии) всё ещё проходят: страж видит актуальный
  `host_id`, который в этих сценариях не менялся.
- Пересчитал бюджет операторов на порцию: страж (1) + `WIPE` (4) + до 6 по
  сущностям + запись состояния (1) = 12, в пределах 32 у оболочки; это же
  число подтверждено фактическим batches-тестом (`applies the same page
again…`, 5 операторов без очистки).
- Ограничил область правки только `src/local/reference-sync.ts`,
  `test/reference-sync.test.ts` и `AGENTS.md` — `apps/station`, Rust,
  `HostApi.getChanges`, `test/support/office.tsx`, `test/api.test.ts` не
  трогал (в этом раунде правки в них не требовались).
- Ни разу не использовал `git stash`, `pnpm install`/`add`, `--no-verify`.
  Коммит один, поверх предыдущего (не `amend`), явные пути в `git add`.
- Проверил трейлер `git log -1 --format=%B` — совпадает дословно с
  требованием раунда.
- Не оставил в коде временных пометок отката (`grep -rn "TEMP-REVERT"` по
  `apps/standalone` — пусто) после восстановления фикса.

## Follow-up

Отчёт о раунде 1 честно сказал, что без защиты от отсутствия прогресса тест
вешал раннер целиком (петля забирала только уже готовые промисы и морила
таймер Vitest). Координатор отметил: та же логика значит, что регресс защиты
в будущем не провалит CI, а заморозит его. Попросил сделать тест неспособным
зависнуть в принципе — ограничить поддельную ленту счётчиком вызовов с
отдельной, узнаваемой ошибкой, и проверять именно сообщение стража (не факт
падения), чтобы утверждение доказывало, что цикл остановил именно страж, а не
предел счётчика. Коммит `1a3409b7a`.

### Что изменено

`apps/standalone/test/reference-sync.test.ts`, тест «refuses a feed that
claims more pages without advancing the revision»: поддельная `changes`
теперь считает вызовы и на шестом (`calls > 5`) бросает `new Error("the loop
did not stop")` вместо того, чтобы бесконечно отвечать той же ревизией.
Утверждение `.rejects.toThrow(/no progress/)` осталось прежним — оно уже
проверяло именно сообщение стража, а не факт отказа; теперь оно к тому же
доказывает, что цикл остановился на страже, а не на пределе счётчика: если
бы страж исчез, тест получил бы «the loop did not stop» и упал бы на
несовпадении сообщений, за миллисекунды, а не завис.

### Проверка других новых/изменённых тестов раунда 1 на тот же риск

Прошёлся по всем 6 добавленным и 2 изменённым на месте тестам раунда 1:

- **ENTITY_SET** («stays org_profile,site,lines») — не вызывает
  `syncReferences` вовсе; риска нет.
- **обновление `ref_org`** и **обновление `ref_site`** — обе `syncReferences`
  в каждом тесте используют страницы с `hasMore` по умолчанию `false`; цикл
  всегда завершается после одной страницы на вызов. Риска нет.
- **гонка переподключения** («rejects a stale in-flight page…») — три вызова
  `syncReferences` (A, B и возобновлённый A), во всех страницах `hasMore`
  явно или по умолчанию `false`. Даже без `hostGuard` этот сценарий портит
  данные, но не зацикливается: цикл в каждом отдельном вызове завершается
  после одной страницы. Риска нет.
- **`stop()` с отложенным триггером в очереди** — не вызывает
  `syncReferences`, работает только с `createSyncScheduler` и вручную
  управляемыми промисами (`finish`); риска нет.
- **`other_host` с взведённой отложенной очисткой** — единственная страница
  имеет `hasMore: false` (третий позиционный аргумент `page(...)` — `false`),
  и вдобавок ответ `other_host` возвращается до проверки прогресса на первом
  же вызове. Риска нет.
- **нечитаемая запись с взведённой отложенной очисткой** — единственная
  страница с `hasMore` по умолчанию `false`; `pageStatements` бросает при
  разборе записи до какого-либо продолжения цикла. Риска нет.

Только у теста защиты от отсутствия прогресса поддельная лента была
сконструирована так, чтобы намеренно никогда не продвигать `since` — это
единственный тест, где страж — единственное, что вообще останавливает цикл,
и единственный, где имело смысл добавлять предохранитель.

### RED (после округления)

Убрал защиту из кода второй раз (тот же участок
`if (page.hasMore && page.rev <= since) { throw ...}` в `syncReferences`),
прогнал только этот тест:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "claims more pages without advancing"
```

```
 ❯ test/reference-sync.test.ts (20 tests | 1 failed | 19 skipped) 6ms
     × refuses a feed that claims more pages without advancing the revision 5ms

 FAIL  test/reference-sync.test.ts > reference sync > refuses a feed that claims more pages without advancing the revision
AssertionError: expected [Function] to throw error matching /no progress/ but got 'the loop did not stop'

- Expected:
/no progress/

+ Received:
"the loop did not stop"

 Test Files  1 failed (1)
      Tests  1 failed | 19 skipped (20)
   Duration  554ms (transform 46ms, setup 37ms, import 53ms, tests 6ms, environment 333ms)
```

Тест упал за 5 мс (полный прогон команды — 554 мс, почти целиком накладные
расходы pnpm/Vitest), без зависания: без стража цикл действительно доходит
до предела счётчика и получает «the loop did not stop», а не «no progress»
— утверждение ловит именно ЭТУ разницу, доказывая, что в норме останавливает
цикл страж, а не счётчик. Никакой фоновой задачи в этот раз останавливать не
пришлось. Восстановил защиту, убедился, что временных пометок отката не
осталось (`grep -rn "TEMP-REVERT"` по `apps/standalone` — пусто).

### GREEN и проверки

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts
```

→ `Test Files  1 passed (1)` / `Tests  20 passed (20)`.

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
```

→ `Test Files  22 passed (22)` / `Tests  330 passed (330)` (число тестов не
изменилось — правка усилила существующий тест, не добавила новый).

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
```

→ чисто.

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

→ чисто.

```
node_modules/.bin/prettier --check apps/standalone/test/reference-sync.test.ts
```

→ `All matched files use Prettier code style!`.

`git diff --check` (до коммита) и `git diff --check HEAD~1 HEAD` (после) →
чисто, без вывода.

### Файлы

- `apps/standalone/test/reference-sync.test.ts` — только тест защиты от
  отсутствия прогресса: добавлен счётчик вызовов с ограничением 5 и отдельной
  ошибкой; остальной текст теста (в том числе оба существующих `expect`) не
  тронут.

### Отклонения

Ни одного. Изменение ограничено ровно тем файлом и тем тестом, который
просил координатор; `src/local/reference-sync.ts` в этом раунде не менялся
(идентичен зафиксированному в `66088d759`, подтверждено пустым `git diff` по
этому файлу перед коммитом).

### Самопроверка

- Убедился, что `git diff apps/standalone/src/local/reference-sync.ts` пуст
  перед коммитом — временный откат защиты для RED был полностью отменён и не
  просочился в коммит.
- Проверил, что оба прежних утверждения теста (`rejects.toThrow(/no
progress/)` и `toHaveBeenCalledTimes(1)`) сохранены дословно — правка
  только добавила счётчик и заменила комментарий, не ослабив ни одной
  проверки.
- Перепроверил остальные 7 тестов раунда 1 на риск зависания по коду (см.
  раздел выше), а не только по названию — для каждого явно нашёл, почему
  `hasMore` не может остаться `true` без продвижения `since` в этом сценарии.
- Коммит один, поверх предыдущего (не `amend`), явный путь в `git add`.
  Трейлер `git log -1 --format=%B` совпадает дословно с требованием.
- Не использовал `git stash`, `pnpm install`/`add`, `--no-verify`.

## Follow-up 2

Повторное ревью одобрило задачу 1 («гонка закрыта в каждом порядке, который
проследил ревьюер, и оболочка проверяет страж»), но попросило один
завершающий раунд из 7 пунктов: остаточный случай первой синхронизации,
вторую гонку для исходного теста, снятие приведения типов, согласованность
данных теста с контрактом ленты, повисшую ссылку на игнорируемый отчёт, нит
в `AGENTS.md` и необязательную проверку состояния БД. Коммит `f06b7b322`.

### Что изменено

1. **Остаточный случай: первая синхронизация старого хоста ещё не завершена.**
   `stored.hostId === null` (справочников ещё нет) означало, что новый прогон
   идёт по ветке отложенной очистки и ничего не помечает заранее. Если
   устаревшая порция старого хоста фиксируется первой, её страж не находит
   строки и проходит, а затем страж НОВОГО (актуального) прогона отказывает —
   тот тоже читал пустой `host_id` и решение принял до фиксации. Старые копии
   остаются читаемыми до следующего триггера.
   Фикс в `apps/standalone/src/local/reference-sync.ts`: когда
   `stored.hostId === null`, ветка `else` теперь сразу — до первого запроса —
   выполняет `local.transaction([{ sql: WRITE_HOST_ID, values: [hostId] }])`
   (без очистки: копий без `host_id` не бывает). С этого момента у ЛЮБОГО
   порядка фиксации есть строка `host_id`, с которой сверяется `hostGuard`.
2. **Вторая гонка для исходного теста.** Добавлен вариант, где заявка B
   (переподключение) тоже держится открытой: страница A фиксируется первой и
   должна провалиться с `changes_mismatch`, копии — пустые, `host_id` — B (тут
   же, а не после страницы B, поскольку преамбула немедленной очистки B —
   один синхронный шаг до её собственного запроса). Затем разрешается
   страница B и проверяются её копии.
3. **Снятие приведения типов** в исходном тесте гонки: `(error as
LocalDbError).code` заменено на `expect(error).toBeInstanceOf(LocalDbError)`
   - `expect(error).toMatchObject({ code: "changes_mismatch" })`; та же пара
     используется в обоих новых тестах — приведений в файле больше нет.
4. **Данные теста гонки против контракта ленты.** При `hasMore: false`
   собственная `rev` порции обязана быть не меньше `rev` любой записи в ней;
   `page(5, [orgB@20])`/`page(11, [orgA@50])` этому противоречили. Заменено на
   `page(20, [orgB@20])`/`page(50, [orgA@50])`, с соответствующим
   `state(20, OTHER_HOST)` вместо `state(5, ...)`.
5. **Повисшая ссылка.** У теста защиты от отсутствия прогресса убрана фраза
   «(see the fix-round report)» — `.superpowers/` не отслеживается git и
   недоступен вне этой сессии; причина (тесная петля морит таймер Vitest)
   осталась.
6. **Нит в `AGENTS.md`.** Перифраз стража `UPDATE ... WHERE host_id <> ?`
   заменён на точный SQL `UPDATE sync_state SET value = value WHERE key =
'host_id' AND value <> ?`. Заодно абзац расширен: первая синхронизация (не
   только переподключение) тоже метит `host_id` заранее, и страж ловит
   гонку «в любом порядке — включая две первые синхронизации, гоняющиеся друг
   за другом». Числа операторов на порцию в прозе `AGENTS.md` не было —
   добавлять было нечего (счётчик уже точен в JSDoc `pageStatements`).
7. **Необязательная, дешёвая проверка.** У теста двойного отката добавлено
   `const { db, executor } = openLocalDb()` и утверждение состояния после
   отказа: копии — ровно то, что применила первая порция отката (одна строка
   `ref_lines` на ревизии 8), вторая (пустая, ревизия 5) не тронула ничего,
   поскольку её отбрасывает проверка `rev < since` до какой-либо транзакции.

### Существенное отклонение: конструкция теста пункта 1

Формулировка пункта 1 («A's first sync ... is held open. B then pairs and
syncs. A's page must fail... host_id must be B») и абзац с механизмом бага
над ней («If the stale page from the OLD host commits first, its guard finds
no row and passes, and then the NEW run's OWN guard fails once») по буквам
описывают, похоже, разные роли для «A»/«B» относительно «old»/«new». Я
проверил обе трактовки вручную по коду и остановился на механизме (не на
кратком пункте), по двум причинам:

- порядок «сначала полностью завершается B (не held open), затем поздняя
  страница A» — то есть буквальное чтение пункта — уже безопасен и БЕЗ
  фикса этого раунда: страж B, работающий по уже существующей (раунд 1)
  логике немедленной очистки, не находит записи (первым пишет именно он) и
  проходит, а страж A потом находит host_id = B и отказывает. Я проверил это
  прогоном (тест с буквальной конструкцией не краснеет без фикса), так что
  такой тест не соответствовал бы требованию «show the test red without the
  stamp»;
- сценарий из абзаца — обе стороны читают `host_id = null` одновременно, и
  именно НОВАЯ сторона может ошибочно отказать — воспроизводится (см. RED
  ниже) и закрывается ровно предложенным фиксом (метка `host_id` до первого
  запроса).

Тест `stamps host_id before the first fetch...` называет переменные `old`/
`new` (не `A`/`B`) и явно комментирует, какая сторона «стала текущей», чтобы
не полагаться на порядок объявления. Итоговый исход детерминирован: старт
преамбулы Old, затем New — так что New владеет `host_id`, и именно страница
Old (не New) отклоняется. Это то же отношение «кто фиксируется последним,
тот и остаётся», что и в буквальном прочтении пункта, просто на уровне
преамбул, а не итоговых страниц.

### Побочная находка при построении теста пункта 1

Первая версия теста держала открытыми только вызовы `changes` (как в
остальных тестах гонки) и полагалась на порядок, в котором Vitest освобождает
два `vi.waitFor`. Прогон обнаружил взаправдашнюю гонку внутри самого теста:
обе преамбулы (`WRITE_HOST_ID` для Old и для New) — это независимые,
безусловные `UPDATE ... DO UPDATE` без стража, и они реально состязаются за
то, чья транзакция `local.transaction(...)` доедет до фиксации первой; исход
недетерминирован при простом освобождении читений. Один прогон (см. первую
попытку) свалился с `changes_mismatch` у `runOld` вместо ожидаемого
`resolves` — не баг в проверяемом коде, а недетерминизм самого теста.

Решение: `heldOps` в `test/reference-sync.test.ts` — исполнитель, который (а)
выполняет каждое чтение немедленно, но не отдаёт его вызывающей стороне до
`releaseRead()` (значит оба чтения гарантированно видят пустую `sync_state`,
если оба выпущены до отдачи), и (б) не запускает `transaction(...)` вовсе,
пока `releaseWrite(marker)` не найдёт нужную по значению внутри её
`statements` (порядок постановки в очередь у гонки преамбул не гарантирован,
поэтому выбор по позиции не годится) и не выполнит её. `stopHoldingWrites()`
отпускает дальнейшие транзакции (собственные порции уже страниц) без
дальнейшего управления — они больше не участвуют в проверяемой гонке.
Второй баг того же рода (более быстрый в диагностике): после исправления
порядка преамбул порционная транзакция каждой стороны ТОЖЕ уходила в
`held.executor.transaction`, то есть тоже вставала в очередь и никогда не
запускалась сама — тест зависал на 5000 мс (таймаут Vitest), пока не
добавился `stopHoldingWrites()`.

### RED

**Пункт 1.** Временно убрал добавленный блок `if (stored.hostId === null) {
await local.transaction([{ sql: WRITE_HOST_ID, ... }]); }` из `syncReferences`
и прогнал только новый тест:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "stamps host_id before the first fetch"
```

```
 ❯ test/reference-sync.test.ts (22 tests | 1 failed | 21 skipped) 1115ms
     × stamps host_id before the first fetch, so a fresh pairing's own first sync is not rejected by a stale rival's own first sync 1114ms

AssertionError: expected +0 to be 2 // Object.is equality
 ❯ test/reference-sync.test.ts:592:54
    590|     held.releaseRead();
    591|     held.releaseRead();
    592|     await vi.waitFor(() => expect(held.writeCount()).toBe(2));

 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Duration  1.73s
```

Без фикса ни один из прогонов не выполняет `transaction(...)` до своего
запроса, так что `writeCount()` никогда не достигает 2 — `vi.waitFor` падает
по собственному (быстрому, не пятисекундному) таймауту. Восстановил блок.

**Пункт 2.** Временно откатил именно строку раунда 1
(`await local.transaction([...WIPE, { sql: WRITE_HOST_ID, values: [hostId] }]);`
→ `await local.transaction(WIPE);`) и прогнал только новый вариант:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "fails the old host's page as soon as"
```

```
 ❯ test/reference-sync.test.ts (22 tests | 1 failed | 21 skipped) 110ms
     × fails the old host's page as soon as the re-pair's own preamble commits, before B's page even lands 110ms

Error: expected A's stale sync to fail
 ❯ error test/reference-sync.test.ts:530:15

 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Duration  730ms
```

Без штампа `host_id` в транзакции немедленной очистки страница A успешно
фиксируется (её страж не находит строки, поскольку очистка стёрла её и
ничего не записала взамен) — 110 мс, без зависания. Восстановил строку.

Оба отката подтверждены: `git diff apps/standalone/src/local/reference-sync.ts`
пуст до коммита, `grep -rn "TEMP-REVERT" apps/standalone` — пусто.

### GREEN и все команды проверки

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts
```

→ `Test Files 1 passed (1)` / `Tests 22 passed (22)` (было 20; +2: пункты 1
и 2). Прогнан 5 раз подряд (и отдельно новый тест пункта 1 — 5 раз) без
единого расхождения, чтобы исключить недетерминизм, который уже один раз
подвёл при разработке этого самого теста.

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
```

→ `Test Files 22 passed (22)` / `Tests 332 passed (332)` (было 330).

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
```

→ чисто.

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

→ чисто.

```
node_modules/.bin/prettier --check apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/AGENTS.md
```

→ первый прогон нашёл несоответствие форматирования в
`test/reference-sync.test.ts` (два места, где новый код превысил длину
строки — перенос вызова `syncReferences({...})` и объекта в `writes.push`);
`--write` поправил чисто форматирование (проверено по `git diff` — только
перенос строк, без смысловых изменений), повторный `--check` — `All matched
files use Prettier code style!`.

`git diff --check` (до и после коммита, `HEAD~1 HEAD`) — чисто.

### Файлы

- `apps/standalone/src/local/reference-sync.ts` — пункт 1 (штамп `host_id`
  для `stored.hostId === null`); пункты 2–7 не меняли исходный код (только
  документацию и тесты).
- `apps/standalone/test/reference-sync.test.ts` — пункты 1, 2 (новые тесты и
  вспомогательный `heldOps`), 3 (снятие приведения в исходном тесте гонки),
  4 (согласованные `rev`), 5 (убрана ссылка на отчёт), 7 (состояние БД в
  тесте двойного отката).
- `apps/standalone/AGENTS.md` — пункт 6 (точный SQL стража, упоминание
  штампа для первой синхронизации).

### Посторонняя находка (не тронуто)

Перед коммитом `git status` показал ещё одно изменение —
`docs/superpowers/plans/2026-09-27-standalone-1c3-webview-pairing-sync.md` —
которое я не вносил; судя по содержимому (точный SQL стража и «исполнение
задачи 1»), его правит какой-то параллельный процесс планирования,
отслеживающий этот же план. Оставил файл нетронутым и не стейджил его —
исходя из правила «existing changes belong to the user; preserve them and
never … include them in an unrelated commit» — закоммичены только явно
перечисленные пути.

### Самопроверка

- Прогнал тест пункта 1 и полный файл по 5 раз каждый после финальной
  реализации, чтобы отличить «исправлено» от «просто повезло с
  чередованием» — учитывая, что ранняя версия того же теста один раз уже
  падала из-за гонки внутри самого теста (см. «Побочная находка» выше).
- Перепроверил вручную по коду, что `hostGuard` физически не может увидеть
  строку `host_id`, если она удалена тем же батчем раньше него — отсюда
  требование «страж первым», уже задокументированное в раунде 1 и
  неизменное в этом раунде.
- Свёл несоответствие между буквальным пунктом 1 и абзацем-механизмом явным
  прогоном обеих трактовок (см. «Существенное отклонение» выше), а не
  выбором наугад.
- Убедился, что оба отката для RED (пункты 1 и 2) выполнены по отдельности,
  каждый восстановлен и подтверждён пустым diff перед переходом к
  следующему — риск закоммитить недо-восстановленный откат исключён.
- Стейджил явные пути; посторонний файл плана не тронут (см. выше).
- Проверил трейлер `git log -1 --format=%B` — совпадает дословно с
  требованием раунда.
- Не использовал `git stash`, `pnpm install`/`add`, `--no-verify`;
  `apps/station` и Rust не трогал.
