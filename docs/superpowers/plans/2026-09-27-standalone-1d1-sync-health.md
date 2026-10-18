# План 1d1: здоровье синхронизации справочников — карантин записей ленты, повтор с отступом, видимые сбои и очистка копий при сбросе — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Неудачная синхронизация справочников перестаёт быть тихой. Запись ленты, которая не прошла свою схему, уходит в карантин и не держит остальную ленту; неудачный прогон повторяется с отступом, пока хост на связи; цех, выбор линии и шапка офиса показывают сбой и число непринятых записей; сброс подключения очищает локальную базу. Всё это нужно до плана 1d3: по той же ленте поедут операторы и отзыв бейджей, и отозванный бейдж не должен работать на станции, которая выглядит здоровой.

**Architecture:**

- `src-tauri/migrations/0002_sync_quarantine.sql` — таблица карантина `sync_quarantine`.
- `src/local/reference-sync.ts`:
  - живые записи порции делятся на принятые и непрочитанные;
  - непрочитанная запись удаляет более старую локальную копию (правило надгробий) и ложится в карантин; принятая запись и надгробие снимают карантин;
  - всё — в той же одной `local_transaction` порции, не больше 3E + 6 операторов для E сущностей;
  - нарушение контракта ленты — `SyncFeedError`; версия схемы записей — в `entity_set`.
- `src/app/shell.ts` и `src/app/host-link.ts` — класс сбоя (`host`, `local`, `feed`) в состоянии синхронизации и повтор неудачного прогона через 2, 4, 8, 16, 32 с, дальше каждые 60 с, пока связь `online`.
- `HostStatusLine` — предупреждение о сбое и число записей в карантине в той же вежливой живой области: цех, выбор линии, шапка офиса. Выбор линии отличает сбой чтения своей копии от сбоя хоста.
- `src-tauri` — `LocalDb::clear_copies` и `device_forget`, который сначала очищает копии.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, i18next, `@markiro/ui` (`StatusChip`, `Alert`), Vitest 4 с jsdom, `node:sqlite` и поддельными таймерами; Rust — sqlx 0.8.6 (SQLite) и Tauri 2 (mock runtime в тестах IPC).

**Спецификации:**

- Решения контроллера — `.superpowers/sdd/1d1-design.md`; решения владельца от 2026-09-27 в нём обязательны.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`:
  - §5.1 — строка связи;
  - §5.2 — `device_forget`;
  - §5.3 — локальная база;
  - §5.4 — синхронизация справочников.
- План 1c3 (`docs/superpowers/plans/2026-09-27-standalone-1c3-webview-pairing-sync.md`) и его раздел «Отклонения при исполнении»: синхронизация, планировщик, связь в оболочке и строка связи — отправная точка этого плана.

## Global Constraints

**Решения владельца (2026-09-27), обязательные**

1. Запись ленты, которая не прошла свою схему (повреждена или новее, чем понимает эта сборка), уходит в карантин, и доступ по ней закрывается (fails closed):
   - запись не применяется;
   - её локальная копия, если есть, удаляется — только когда `rev` записи в карантине новее `rev` локальной строки (то же правило, что у надгробий);
   - остальная лента применяется, ревизия продвигается;
   - станция и офис показывают, сколько записей не принято: «Не приняты записи справочников: N»;
   - запись возвращается, когда хост меняет её снова (новая читаемая запись снимает карантин) или когда сборка, которая её понимает, синхронизируется с нуля — через версию схемы в наборе сущностей.
2. «Новый код» гасит прежний код подключения — это планы 1d2/1d3, не 1d1.

**Карантин**

- Таблица — миграция `src-tauri/migrations/0002_sync_quarantine.sql`. `0001_reference_data.sql` не использует `STRICT` и `WITHOUT ROWID`, эта тоже:

```sql
CREATE TABLE sync_quarantine (
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  reason TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (entity, id)
);
```

- `reason` никогда не несёт значение записи: в записях операторов будут хеши PHC. Только пути и коды проблем Zod — `путь: код` через `; `; путь самой записи — `data`; не длиннее 200 символов. Пример: `badgeSalt: invalid_format; badgeSalt: too_small; palletBlockSize: invalid_type`.
- `seen_at` — `Date.now()` в момент применения порции, миллисекунды Unix по часам этого ПК. Приходит параметром (`SyncOptions.now`, тесты его закрепляют), не из SQL: `unixepoch()` нельзя.
- Удаление старой копии — тот же условный оператор, что у надгробий: на сущность один `DELETE … WHERE EXISTS (… json_each(?) …)` на надгробия и непрочитанные записи вместе.
- В карантин — один оператор на порцию: `json_each` по объектам `{entity, id, rev, reason}`, `ON CONFLICT (entity, id) DO UPDATE … WHERE excluded.rev > sync_quarantine.rev`.
- Снятие карантина — один `DELETE FROM sync_quarantine WHERE EXISTS (… json_each(?) …)` на порцию: для принятых записей и надгробий с `rev` не меньше `rev` в карантине.
- Каждая очистка копий очищает и `sync_quarantine`: другой хост, другой `entity_set`, откат хоста (`rev < since`).
- После удачного прогона — `SELECT count(*) AS n FROM sync_quarantine` через `local.query`; `SyncResult` `{ kind: "synced" }` получает `quarantined: number`.
- Сущности, которых эта сборка не держит, пропускаются и в карантин не попадают.
- Нарушение контракта ленты (два отката за прогон, `hasMore` без продвижения) — ошибка класса `SyncFeedError`.

**Бюджет операторов порции** (у оболочки — не больше 32)

- Для E сущностей порция — не больше 1 + (E + 2) + 2E + 3 = 3E + 6 операторов:
  - проверка `host_id`;
  - отложенная очистка: E таблиц копий, карантин, `sync_state`;
  - на сущность — одно условное удаление (надгробия и непрочитанные записи) и один upsert;
  - запись в карантин, снятие карантина, запись `sync_state` (один оператор на три ключа).
- Сейчас E = 3 — 15 операторов; с `operators` и `operator_badges` плана 1d3 — 21; предел — E = 8 (30). Число закрепляет тест худшей порции.
- Отдельное удаление для непрочитанных записей, как в брифе, дало бы 4E + 6: 18 сейчас, 26 с планом 1d3 и 34 — больше 32 — с товарами и шаблонами плана 1e. SQL у него тот же, что у удаления по надгробиям, поэтому они слиты в один оператор.

**Версия схемы**

- `SYNC_SCHEMA_VERSION = 2` в `reference-sync.ts`. `entity_set` хранится как ключи `ENTITIES` через запятую, `;v` и версия: `ENTITY_SET = "org_profile,site,lines;v2"`. Устройства сборки 1c3 (`"org_profile,site,lines"`) один раз синхронизируются с нуля.
- Версию поднимают при любом изменении схемы записи или смысла таблицы копий.

**Классы сбоев и повтор**

- `SyncFailure = "host" | "local" | "feed"` — по ошибке прогона (`syncFailureOf` в `src/app/host-link.ts`):
  - `HostError` → `host`, кроме ответа, который эта сборка не может прочитать: `HostError` с `kind: "transport"` и `code: "invalid_response"` → `feed`;
  - `LocalDbError` → `local`;
  - `SyncFeedError` → `feed`;
  - всё остальное → `feed`.
- Отказ ключа или смена сертификата по-прежнему идут через `shellActionFor` и останавливают планировщик; `sync_failed` при этом тоже уходит, повтора нет. После `other_host` повтора нет.
- `SyncState` (`src/app/shell.ts`) — `{ kind, synced, failure: SyncFailure | null, quarantined: number }`. Действия — `{ type: "sync_failed"; failure: SyncFailure }` и `sync_finished` с результатом, в котором есть `quarantined`.
- Редьюсер:
  - `sync_started` сохраняет `failure`: повтор не гасит предупреждение;
  - `sync_finished` очищает `failure` и ставит `quarantined`;
  - `sync_failed` ставит `failure`, `quarantined` не трогает;
  - `other_host` поглощает всё, как раньше;
  - `paired` и `forgotten` сбрасывают всё, как раньше.
- Повтор — паузы 2 с, 4 с, 8 с, 16 с, 32 с, затем 60 с перед каждой следующей попыткой: `nextSyncRetryMs(attempt: number): number`, где `attempt` — число неудачных прогонов подряд (1 после первого).
  - Удачный прогон сбрасывает счёт.
  - Любой запуск (ревизия, `syncNow`, сам повтор) снимает ожидающий таймер: его снимает начало прогона.
  - Статус связи не `online` снимает таймер. Статус `online` после неудачного прогона без таймера запускает прогон сразу.
  - Очистка эффекта (смена `hostId`, отказ, другой хост) снимает таймер.
  - Состояние связи хук берёт из своего `onStatus`; новых свойств нет.

**Тексты** (`src/i18n/ru.json`)

- `link.syncFailed` — «Справочники не обновились — повторим автоматически».
- `errors.sync.host` — «Хост не ответил на запрос.»
- `errors.sync.local` — «Не удалось записать справочники на этом компьютере.»
- `errors.sync.feed` — «Ленту изменений хоста не удалось применить.»
- `link.quarantined` — «Не приняты записи справочников: {{n}}». Переменная не `count`: `count` включил бы формы множественного числа i18next.
- `shell.lineSelect.readFailed` — «Не удалось прочитать справочники на этом компьютере.»
- Выбор линии объясняет неудачную синхронизацию по `sync.failure`: `host` — прежний `shell.lineSelect.syncFailed` («Не удалось получить справочники с хоста.»), `local` и `feed` — те же ключи, что у строки связи: `errors.sync.local` и `errors.sync.feed`. Каждый текст — в `ru.json` один раз.
- Предупреждение о сбое показывается только при связи `online`, число в карантине — при любой связи. Оба — тег фазы `attention` со словами (`StatusChip`, глиф «!»): цвет не единственный признак.

**Сброс подключения**

- `LocalDb::clear_copies()` удаляет все строки всех таблиц, кроме `_sqlx_migrations` и `sqlite_*`, одной транзакцией писателя. Список таблиц — из `sqlite_master`; внешние ключи проверяются при фиксации (`PRAGMA defer_foreign_keys = ON`).
- `device_forget` сначала очищает копии, потом удаляет `device.json`. Неудача очистки — отказ `storage`, `device.json` остаётся.
- Если локальная база не открылась, очищать нечего, и сброс идёт дальше: иначе сломанная база навсегда заперла бы экран сброса. Это осознанное решение для 1d1: план 1d3 пересмотрит его до того, как хеши PIN и бейджей лягут в локальную базу.
- Контракт IPC не меняется: у команды нет аргументов вебвью, ответ — `null`.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`, каждый видимый текст — ключ `ru.json`.
- Новых зависимостей нет — ни JS, ни Rust. `apps/station` не меняется.
- Операторы порции укладываются в правила оболочки (`local_db.rs`, их копия в `test/support/local-db.ts`, общая фикстура `src-tauri/tests/fixtures/local-sql.json`): один оператор, без `;` внутри, без комментариев и запрещённых слов.
- `tools/ci/affected.mjs` уже направляет `apps/standalone/src-tauri/migrations/` в задания вебвью и Rust (`verify_static`, `verify_app_tests`, `standalone_rust`, `standalone_windows_build`), а `src-tauri/build.rs` пересобирает оболочку при изменении миграций. Их не меняем.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; он встречается в файле один раз. Правки внутри шага идут сверху вниз по файлу.
- «Заменить содержимое … целиком» — файл пишется заново, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD: код в плане уже отформатирован, расхождение значит опечатку.
- В задачах с Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.
- `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Новые поддельные таймеры — только в тестах повтора (задача 2): `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true })` и `vi.useRealTimers()` в `afterEach`.
  - Подделан только `setTimeout`: планировщик React (`setImmediate`) и опрос Testing Library остаются настоящими.
  - `shouldAdvanceTime` двигает поддельное время вместе с настоящим, иначе `findBy*` не дождались бы своего `setTimeout(0)`. Проверки «ещё не повторил» стоят с запасом не меньше 1 с до срока.
- React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от эффекта, — скрытый флейк. «Ровно один раз» проверяется так: `waitFor`, два хода `await new Promise((resolve) => setImmediate(resolve))`, снова та же проверка.
- Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.

**Cargo**

- Крейт оболочки встраивает `apps/standalone/dist`, поэтому перед cargo — `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`.
- `--test local_db` и отфильтрованный `--test ipc forgetting_the_device` порт не слушают и идут в песочнице с `--offline`. Полный `cargo test --workspace` слушает 127.0.0.1 — только вне песочницы.
- Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql                 задача 1
apps/standalone/src/local/reference-sync.ts, test/reference-sync.test.ts      задача 1
apps/standalone/test/{local-executor,api}.test.ts                             задача 1
apps/standalone/src-tauri/tests/local_db.rs                                   задачи 1, 4
apps/standalone/test/shell.test.ts                                            задачи 1, 2
apps/standalone/src/app/{shell,host-link}.ts, test/host-link.test.ts          задача 2
apps/standalone/test/{app,line-select}.test.tsx                               задачи 2, 3
apps/standalone/src/app/{HostStatusLine,LineSelect,App}.tsx, src/app/screens.tsx  задача 3
apps/standalone/src/app/shell.css, src/i18n/ru.json                           задача 3
apps/standalone/src/office/{Office,OfficeShell,office-link}.tsx               задача 3
apps/standalone/test/host-status-line.test.tsx                                задача 3
apps/standalone/src-tauri/src/{local_db,lib}.rs, src-tauri/tests/ipc.rs       задача 4
apps/standalone/AGENTS.md                                                     задачи 1–4
спецификация: §5.3, §5.4 — задачи 1, 2; §5.1 — задача 3; §5.2 — задача 4
```

Миграция стоит в задаче 1, а не в задаче 4 вместе с остальным Rust: её таблицу пишет синхронизация задачи 1, а тесты на `node:sqlite` читают миграции оболочки. Поэтому задача 1 правит и оба теста, которые перечисляют таблицы: `test/local-executor.test.ts` и `src-tauri/tests/local_db.rs`. Задача 4 проверяет очистку уже вместе с `sync_quarantine`. Два мелких пункта брифа (раздел 8) вошли в задачи, чьи файлы они трогают: тест ленты в `api.test.ts` — в задачу 1, «ровно один раз» в `app.test.tsx` — в задачу 2.

---

### Task 1: Карантин записей ленты — `src/local/reference-sync.ts`

Сейчас одна плохая запись оставляет всю порцию неприменённой: синхронизация падает и не продвигается, а по ленте с плана 1d3 поедут операторы и отзыв бейджей. По решению владельца запись, не прошедшая свою схему, уходит в карантин и закрывает доступ (fails closed): её более старая локальная копия удаляется по правилу надгробий, остальная порция применяется, ревизия продвигается. Всё остаётся в одной `local_transaction` порции, первой в ней по-прежнему идёт проверка `host_id`.

Сверх брифа удаление старой копии для непрочитанной записи слито с удалением по надгробиям в один оператор на сущность: SQL у них одинаковый, а бюджет порции становится 3E + 6 вместо 4E + 6 (раздел «Бюджет операторов порции» в Global Constraints).

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql`
- Modify (целиком): `apps/standalone/src/local/reference-sync.ts`, `apps/standalone/test/reference-sync.test.ts`
- Modify: `apps/standalone/test/local-executor.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/shell.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.3, §5.4)

**Interfaces:**

- Consumes:
  - `LocalExecutor.query<T>(sql: string, params: readonly unknown[], row: z.ZodType<T>): Promise<T[]>`, `LocalExecutor.transaction(statements: readonly LocalStatement[]): Promise<number[]>`, `LocalStatement { sql; values?; expectedChanges? }` — `src/local/executor.ts`;
  - `openLocalDb(): { db: DatabaseSync; executor: LocalExecutor }` — `test/support/local-db.ts`; читает все `src-tauri/migrations/*.sql` по порядку и держит правила операторов оболочки;
  - `orgRecordSchema`, `siteRecordSchema`, `lineRecordSchema`, `ChangeItem`, `ChangesResponse` — `src/host/protocol.ts`;
  - `HOST_ID` — `test/support/fixtures.ts`.
- Produces:
  - таблица `sync_quarantine(entity, id, rev, reason, seen_at)` с ключом `(entity, id)`;
  - `type SyncResult = { kind: "synced"; rev: number; quarantined: number } | { kind: "other_host" }`;
  - `interface SyncOptions { changes: (since: number) => Promise<ChangesResponse>; local: LocalExecutor; hostId: string; now?: () => number }`;
  - `class SyncFeedError extends Error` (`name` — `"SyncFeedError"`);
  - `ENTITY_SET = "org_profile,site,lines;v2"`;
  - `syncReferences(options: SyncOptions): Promise<SyncResult>` и `createSyncScheduler(run: () => Promise<void>): SyncScheduler` — прежние сигнатуры.

- [ ] **Step 1: Тесты (падающие)**

Тест синхронизации переписан целиком. Что в нём нового:

- `ENTITY_SET` несёт версию схемы;
- каждый удачный результат несёт `quarantined`;
- повторная порция пишет ещё и снятие карантина (оно ничего не меняет);
- оба нарушения контракта ленты — `SyncFeedError`;
- тест «плохая запись оставляет порцию неприменённой» заменён разделом «sync quarantine»:
  - карантин и применение остальной порции;
  - удаление копии, только если запись новее;
  - снятие карантина новой записью или надгробием, но не более старыми;
  - одна запись в карантине на ключ;
  - причина без значений, не длиннее 200 символов;
  - очистка карантина вместе с копиями;
  - худшая порция — ровно 15 операторов;
- тест гонки двух первых синхронизаций отпускает и завершающее чтение числа записей в карантине: `heldOps` держит каждое чтение.

1. Заменить содержимое `apps/standalone/test/reference-sync.test.ts` целиком:

```ts
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  createSyncScheduler,
  ENTITY_SET,
  SyncFeedError,
  syncReferences,
} from "../src/local/reference-sync.js";
import { HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const LINE_1 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_2 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
/** When a test's pages are applied, on this computer's clock. */
const SEEN_AT = 1_790_000_000_000;

const ORG: ChangeItem = {
  entity: "org_profile",
  id: "1",
  rev: 41,
  deleted: false,
  data: {
    name: "ООО «Атолл»",
    inn: null,
    gln: "4600682000013",
    gs1Prefixes: ["4600682", "4607091"],
    timeZone: "Europe/Moscow",
  },
};
const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 41,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};

function line(id: string, rev: number, name: string, archived = false): ChangeItem {
  return { entity: "lines", id, rev, deleted: false, data: { name, archived } };
}

function tombstone(id: string, rev: number): ChangeItem {
  return { entity: "lines", id, rev, deleted: true };
}

/** A line whose `archived` is not a boolean: it fails its schema. */
function brokenLine(id: string, rev: number): ChangeItem {
  return { entity: "lines", id, rev, deleted: false, data: { name: "Линия 1", archived: "да" } };
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}

/** A change feed answering each `since` with its page; any other `since` fails the sync. */
function feed(pages: Record<number, ChangesResponse>) {
  return vi.fn(async (since: number) => {
    const answer = pages[since];
    if (answer === undefined) throw new Error(`unexpected since=${since}`);
    return answer;
  });
}

/** The copies and the sync state as plain rows. */
function tables(db: DatabaseSync) {
  const rows = (sql: string) => Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  return {
    org: rows("SELECT id, name, inn, gln, gs1_prefixes, time_zone, rev FROM ref_org"),
    site: rows("SELECT id, badge_salt, box_block_size, pallet_block_size, rev FROM ref_site"),
    lines: rows("SELECT id, name, archived, rev FROM ref_lines ORDER BY name"),
    state: rows("SELECT key, value FROM sync_state ORDER BY key"),
  };
}

/** The quarantined records as plain rows. */
function quarantine(db: DatabaseSync) {
  const sql = "SELECT entity, id, rev, reason, seen_at FROM sync_quarantine ORDER BY entity, id";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
}

function state(lastRev: number, hostId = HOST_ID) {
  return [
    { key: "entity_set", value: ENTITY_SET },
    { key: "host_id", value: hostId },
    { key: "last_rev", value: String(lastRev) },
  ];
}

/** Two synced lines at revisions 10 and 20, from `HOST_ID`. */
async function syncedTwoLines(executor: LocalExecutor): Promise<void> {
  await syncReferences({
    changes: feed({ 0: page(20, [line(LINE_1, 10, "Линия 1"), line(LINE_2, 20, "Линия 2")]) }),
    local: executor,
    hostId: HOST_ID,
  });
}

/** An executor that records how many rows each statement of each batch changed. */
function counting(executor: LocalExecutor) {
  const batches: number[][] = [];
  const counted: LocalExecutor = {
    query: (sql, params, row) => executor.query(sql, params, row),
    transaction: async (statements) => {
      const changes = await executor.transaction(statements);
      batches.push(changes);
      return changes;
    },
  };
  return { executor: counted, batches };
}

/**
 * An executor whose `query` reads immediately (capturing whatever is
 * committed at that instant) but only delivers the result once released,
 * and whose `transaction` does not run at all until released — so two
 * `syncReferences` runs can be made to race deterministically: both reading
 * `sync_state` before either writes, and their writes ordered by choice
 * rather than by whichever happens to reach `transaction` first. Reads are
 * released oldest-first (their order of arrival is reliable, since nothing
 * else runs between two synchronous `releaseRead` calls); writes are found
 * by a value one of their statements carries, since two racing preambles
 * can reach `transaction` in either order. `stopHoldingWrites` lets every
 * write after the ones the test cared about (each run's own page batch,
 * once the preamble race is already settled) proceed immediately, so the
 * test does not also have to schedule those.
 */
function heldOps(executor: LocalExecutor) {
  const reads: Array<() => void> = [];
  const writes: Array<{ statements: readonly LocalStatement[]; run: () => void }> = [];
  let holdWrites = true;
  const held: LocalExecutor = {
    query: async (sql, params, row) => {
      const result = await executor.query(sql, params, row);
      await new Promise<void>((resolve) => reads.push(resolve));
      return result;
    },
    transaction: (statements) => {
      if (!holdWrites) return executor.transaction(statements);
      return new Promise<number[]>((resolve, reject) => {
        writes.push({
          statements,
          run: () => executor.transaction(statements).then(resolve, reject),
        });
      });
    },
  };
  return {
    executor: held,
    readCount: () => reads.length,
    writeCount: () => writes.length,
    releaseRead: () => reads.shift()?.(),
    /** Releases the queued write with a statement whose `values` include `marker`. */
    releaseWrite: (marker: string) => {
      const index = writes.findIndex((w) => w.statements.some((s) => s.values?.includes(marker)));
      const [write] = writes.splice(index, 1);
      write?.run();
    },
    stopHoldingWrites: () => {
      holdWrites = false;
    },
  };
}

describe("ENTITY_SET", () => {
  it("names the kept entities and the version of their records", () => {
    // Derived from the entity table and `SYNC_SCHEMA_VERSION`; pinned so a
    // build cannot change one and forget the other.
    expect(ENTITY_SET).toBe("org_profile,site,lines;v2");
  });
});

describe("reference sync", () => {
  it("copies every record of the first full sync", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(42, [line(LINE_2, 40, "Линия 2", true), ORG, SITE, line(LINE_1, 42, "Линия 1")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
    });
    expect(changes).toHaveBeenCalledWith(0);
    expect(tables(db)).toEqual({
      org: [
        {
          id: "1",
          name: "ООО «Атолл»",
          inn: null,
          gln: "4600682000013",
          gs1_prefixes: '["4600682","4607091"]',
          time_zone: "Europe/Moscow",
          rev: 41,
        },
      ],
      site: [
        {
          id: "1",
          badge_salt: "AAECAwQFBgcICQoLDA0ODw==",
          box_block_size: 2000,
          pallet_block_size: 200,
          rev: 41,
        },
      ],
      lines: [
        { id: LINE_1, name: "Линия 1", archived: 0, rev: 42 },
        { id: LINE_2, name: "Линия 2", archived: 1, rev: 40 },
      ],
      state: state(42),
    });
  });

  it("updates an existing org record when a newer revision changes its fields", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(41, [ORG]) }),
      local: executor,
      hostId: HOST_ID,
    });
    const changedOrg: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 50,
      deleted: false,
      data: {
        name: "ООО «Атолл Новый»",
        inn: "7701234567",
        gln: "4600682000099",
        gs1Prefixes: ["4611111"],
        timeZone: "Asia/Yekaterinburg",
      },
    };
    await syncReferences({
      changes: feed({ 41: page(50, [changedOrg]) }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(tables(db).org).toEqual([
      {
        id: "1",
        name: "ООО «Атолл Новый»",
        inn: "7701234567",
        gln: "4600682000099",
        gs1_prefixes: '["4611111"]',
        time_zone: "Asia/Yekaterinburg",
        rev: 50,
      },
    ]);
  });

  it("updates an existing site record when a newer revision changes its fields", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(41, [SITE]) }),
      local: executor,
      hostId: HOST_ID,
    });
    const changedSite: ChangeItem = {
      entity: "site",
      id: "1",
      rev: 55,
      deleted: false,
      data: { badgeSalt: "ZGVmZ2hpamtsbW5vcHFycw==", boxBlockSize: 3000, palletBlockSize: 300 },
    };
    await syncReferences({
      changes: feed({ 41: page(55, [changedSite]) }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(tables(db).site).toEqual([
      {
        id: "1",
        badge_salt: "ZGVmZ2hpamtsbW5vcHFycw==",
        box_block_size: 3000,
        pallet_block_size: 300,
        rev: 55,
      },
    ]);
  });

  it("follows the feed page by page from the last applied revision", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(41, [ORG, SITE], true),
      41: page(42, [line(LINE_1, 42, "Линия 1")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
    });
    expect(changes.mock.calls).toEqual([[0], [41]]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(tables(db).state).toEqual(state(42));

    // The next sync asks only for what came after.
    const next = feed({ 42: page(43, [line(LINE_1, 43, "Линия 1 (упаковка)")]) });
    await syncReferences({ changes: next, local: executor, hostId: HOST_ID });
    expect(next.mock.calls).toEqual([[42]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (упаковка)", archived: 0, rev: 43 },
    ]);
  });

  it("applies the same page again without changing a record", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({ 0: page(42, [ORG, SITE, line(LINE_1, 42, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    const before = tables(db);
    // As if the revision were lost: the same page arrives again.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    const recorded = counting(executor);
    await syncReferences({ changes, local: recorded.executor, hostId: HOST_ID });
    expect(tables(db)).toEqual(before);
    // The guard passed (0: `host_id` still matched), the three upserts found
    // nothing newer and nothing was quarantined to lift; only the sync state
    // was written.
    expect(recorded.batches).toEqual([[0, 0, 0, 0, 0, 3]]);
  });

  it("deletes by tombstone, but never a record newer than the tombstone", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({ 20: page(30, [tombstone(LINE_1, 25), tombstone(LINE_2, 15)]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_2, name: "Линия 2", archived: 0, rev: 20 }]);
    expect(tables(db).state).toEqual(state(30));
  });

  it("starts again from zero when the host went back to an older revision", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // Restored from a copy taken at revision 12: `rev` is below the device's.
    const changes = feed({
      20: page(12, []),
      0: page(12, [line(LINE_1, 12, "Линия 1 (из копии)")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 12,
      quarantined: 0,
    });
    expect(changes.mock.calls).toEqual([[20], [0]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (из копии)", archived: 0, rev: 12 },
    ]);
    expect(tables(db).state).toEqual(state(12));
  });

  it("keeps the previous copies when the rollback's own refetch fails", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const before = tables(db);
    // The host went back (rev < since), but the refetch from zero — the
    // request that would carry the deferred wipe — never lands.
    const changes = vi.fn(async (since: number) => {
      if (since === 20) return page(12, []);
      throw new Error("host unreachable");
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      "host unreachable",
    );
    expect(changes.mock.calls).toEqual([[20], [0]]);
    // Spec §5.4: the copies stay until the first new page actually lands.
    expect(tables(db)).toEqual(before);
  });

  it("gives up when the host goes back twice in one sync", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({
      20: page(12, []),
      0: page(8, [line(LINE_1, 8, "Линия 1")], true),
      8: page(5, []),
    });
    const run = syncReferences({ changes, local: executor, hostId: HOST_ID });
    await expect(run).rejects.toThrow(/went back twice/);
    await expect(run).rejects.toBeInstanceOf(SyncFeedError);
    // The second rollback's page (empty, at rev 5) is caught before any
    // transaction: the copies still hold exactly what the first restart
    // applied (page 8's single line), untouched by the second.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_1, name: "Линия 1", archived: 0, rev: 8 }],
      state: state(8),
    });
  });

  it("refuses a feed that claims more pages without advancing the revision", async () => {
    const { executor } = openLocalDb();
    // Answers every `since` with a page at that same revision, forever — but
    // bounded, so a regression that drops the guard fails this test fast
    // (a distinct error) instead of hanging it: the retry loop only awaits
    // already-resolved promises, so it starves Vitest's own timer and its
    // `--testTimeout` never fires.
    let calls = 0;
    const changes = vi.fn(async (since: number) => {
      calls += 1;
      if (calls > 5) throw new Error("the loop did not stop");
      return page(since, [], true);
    });
    const run = syncReferences({ changes, local: executor, hostId: HOST_ID });
    await expect(run).rejects.toThrow(/no progress/);
    await expect(run).rejects.toBeInstanceOf(SyncFeedError);
    // The guard's own message, not the bound's: proves the guard stopped the
    // loop, not the counter. Caught on the first page, not after looping.
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("wipes the copies of a pairing with another host before anything else", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [ORG, line(LINE_2, 20, "Чужая линия")], false, OTHER_HOST) }),
      local: executor,
      hostId: OTHER_HOST,
    });
    // Paired with HOST_ID now, and the host is out of reach.
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID }),
    ).rejects.toThrow("host unreachable");
    // The immediate wipe itself already committed, with no `last_rev`: the
    // copies still read as unsynced, and a stale in-flight run for the old
    // host would still find `host_id` repointed to this one.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: [{ key: "host_id", value: HOST_ID }],
    });

    const changes = feed({ 0: page(5, [line(LINE_1, 5, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 5 }]);
    expect(tables(db).state).toEqual(state(5));
  });

  it("rejects a stale in-flight page for the old host after a re-pair wiped its copies", async () => {
    const { db, executor } = openLocalDb();
    // Host A is fully synced (no org data yet).
    await syncReferences({
      changes: feed({ 0: page(10, []) }),
      local: executor,
      hostId: HOST_ID,
    });
    // A's next sync starts a request that stays in flight until resolved below.
    let resolveA: ((value: ChangesResponse) => void) | undefined;
    const aChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveA = resolve;
        }),
    );
    const runA = syncReferences({ changes: aChanges, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(aChanges).toHaveBeenCalledWith(10));

    // Meanwhile the device is re-paired to B, which wipes and takes over —
    // `stop()` on A's scheduler cannot cancel A's in-flight request. B writes
    // its own org profile, at a lower row revision than A's late page below.
    const orgB: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 20,
      deleted: false,
      data: {
        name: "ООО «Б»",
        inn: null,
        gln: "4600682000099",
        gs1Prefixes: ["4611111"],
        timeZone: "Asia/Yekaterinburg",
      },
    };
    // With `hasMore: false`, the page's own `rev` must be at least every
    // item's `rev` — B's page is at revision 20, matching `orgB`.
    await expect(
      syncReferences({
        changes: feed({ 0: page(20, [orgB], false, OTHER_HOST) }),
        local: executor,
        hostId: OTHER_HOST,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });

    // A's late page arrives, with a *higher* row revision for the same org id
    // ('1' on every host): unguarded, `excluded.rev > ref_org.rev` would let
    // it win and resurrect A's (stale) org profile over B's. The page's own
    // `rev` (50) matches `orgA`'s, for the same reason as B's above.
    const orgA: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 50,
      deleted: false,
      data: {
        name: "ООО «А»",
        inn: null,
        gln: "4600682000013",
        gs1Prefixes: ["4600682"],
        timeZone: "Europe/Moscow",
      },
    };
    resolveA?.(page(50, [orgA], false, HOST_ID));

    // It must be rejected instead.
    const error: unknown = await runA.then(
      () => {
        throw new Error("expected A's stale sync to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    expect(tables(db)).toEqual({
      org: [
        {
          id: "1",
          name: "ООО «Б»",
          inn: null,
          gln: "4600682000099",
          gs1_prefixes: '["4611111"]',
          time_zone: "Asia/Yekaterinburg",
          rev: 20,
        },
      ],
      site: [],
      lines: [],
      state: state(20, OTHER_HOST),
    });
  });

  it("fails the old host's page as soon as the re-pair's own preamble commits, before B's page even lands", async () => {
    const { db, executor } = openLocalDb();
    // Host A is fully synced.
    await syncReferences({
      changes: feed({ 0: page(10, []) }),
      local: executor,
      hostId: HOST_ID,
    });
    // A's next sync starts a request that stays in flight.
    let resolveA: ((value: ChangesResponse) => void) | undefined;
    const aChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveA = resolve;
        }),
    );
    const runA = syncReferences({ changes: aChanges, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(aChanges).toHaveBeenCalledWith(10));

    // B re-pairs; B's own fetch is held open too, but its preamble — the
    // immediate wipe and `host_id` stamp — runs synchronously before any
    // fetch, so it does not need to win a race against A's pending one.
    let resolveB: ((value: ChangesResponse) => void) | undefined;
    const bChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveB = resolve;
        }),
    );
    const runB = syncReferences({ changes: bChanges, local: executor, hostId: OTHER_HOST });
    await vi.waitFor(() => expect(bChanges).toHaveBeenCalledWith(0));

    // A's page lands first, while B's is still pending.
    resolveA?.(page(11, [line(LINE_1, 11, "Линия A (поздно)")], false, HOST_ID));
    const error: unknown = await runA.then(
      () => {
        throw new Error("expected A's stale sync to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    // B's preamble already wiped A's copies and claimed `host_id`, even
    // though B's own page has not landed yet.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: [{ key: "host_id", value: OTHER_HOST }],
    });

    // B's page lands second.
    resolveB?.(page(20, [line(LINE_2, 20, "Линия B")], false, OTHER_HOST));
    await expect(runB).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия B", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
  });

  it("stamps host_id before the first fetch, so a fresh pairing's own first sync is not rejected by a stale rival's own first sync", async () => {
    const { db, executor } = openLocalDb();
    const held = heldOps(executor);

    // Two first syncs start "at the same time": both read `sync_state`
    // before either has had a chance to act on it — for example, a
    // device's very first sync for host X is still reading state when it
    // is re-paired to Y, and Y's own first sync starts and reads the same
    // still-empty state before X has committed anything.
    let resolveOld: ((value: ChangesResponse) => void) | undefined;
    const oldChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const runOld = syncReferences({ changes: oldChanges, local: held.executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(held.readCount()).toBe(1));

    let resolveNew: ((value: ChangesResponse) => void) | undefined;
    const newChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveNew = resolve;
        }),
    );
    const runNew = syncReferences({
      changes: newChanges,
      local: held.executor,
      hostId: OTHER_HOST,
    });
    await vi.waitFor(() => expect(held.readCount()).toBe(2));

    // Release both reads: each already captured `sync_state` completely
    // empty, since neither run could have written anything before both
    // reads were issued. Each now queues its own preamble stamp instead of
    // running it, so the order of those two writes can be chosen below
    // rather than left to chance.
    held.releaseRead();
    held.releaseRead();
    await vi.waitFor(() => expect(held.writeCount()).toBe(2));

    // Old's stamp commits first, New's second: New ends up "claiming"
    // `host_id`, exactly as if the re-pair to New happened a moment after
    // Old's own first sync had already started. From here on, each run's
    // own page batch (the only other transaction either will run) can
    // proceed on its own: the preamble race is already settled.
    held.releaseWrite(HOST_ID);
    await vi.waitFor(() => expect(held.writeCount()).toBe(1));
    held.releaseWrite(OTHER_HOST);
    held.stopHoldingWrites();
    await vi.waitFor(() => expect(oldChanges).toHaveBeenCalledWith(0));
    await vi.waitFor(() => expect(newChanges).toHaveBeenCalledWith(0));

    // Old's page lands...
    resolveOld?.(page(10, [line(LINE_1, 10, "Линия старого хоста")], false, HOST_ID));
    const error: unknown = await runOld.then(
      () => {
        throw new Error("expected the stale first sync to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });

    // ...and, since New's stamp is what `host_id` ended up holding, its own
    // page succeeds — the stale rival's first sync never got a chance to
    // corrupt it, even though both started from the very same empty state.
    resolveNew?.(page(20, [line(LINE_2, 20, "Линия нового хоста")], false, OTHER_HOST));
    // Its closing read of the quarantine count is held like every read.
    await vi.waitFor(() => expect(held.readCount()).toBe(1));
    held.releaseRead();
    await expect(runNew).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия нового хоста", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
  });

  it("stops at a feed from another host without applying anything, even with a deferred wipe pending", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // A build with a different entity set arms a deferred wipe for the next page.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    const before = tables(db);
    const changes = feed({ 0: page(42, [ORG, line(LINE_1, 42, "Линия 1")], false, OTHER_HOST) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "other_host",
    });
    // The armed wipe never ran: `other_host` short-circuits before any transaction.
    expect(tables(db)).toEqual(before);
  });

  it("syncs from zero for another entity set, keeping the copies until a page arrives", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // Written by a build that kept fewer entities.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    expect(tables(db).lines).toHaveLength(2);

    const changes = feed({ 0: page(20, [SITE, line(LINE_1, 10, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 10 }]);
    expect(tables(db).site).toHaveLength(1);
    expect(tables(db).state).toEqual(state(20));
  });

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    const operator: ChangeItem = {
      entity: "operators",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { login: "1001" },
    };
    const changes = feed({ 0: page(42, [operator, line(LINE_1, 42, "Линия 1")]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
    });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    // Records of another build's entities are not this build's to judge.
    expect(quarantine(db)).toEqual([]);
  });
});

describe("sync quarantine", () => {
  it("quarantines a record that fails its schema and applies the rest of the page", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    const changes = feed({ 0: page(42, [ORG, broken, line(LINE_1, 42, "Линия 1")]) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, now: () => SEEN_AT }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 1 });
    expect(tables(db).org).toHaveLength(1);
    expect(tables(db).site).toEqual([]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(tables(db).state).toEqual(state(42));
    expect(quarantine(db)).toEqual([
      {
        entity: "site",
        id: "1",
        rev: 41,
        reason: "badgeSalt: invalid_format; badgeSalt: too_small; palletBlockSize: invalid_type",
        seen_at: SEEN_AT,
      },
    ]);
  });

  it("fails closed: an unreadable record newer than the copy deletes it, an older one does not", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({ 20: page(30, [brokenLine(LINE_1, 25), brokenLine(LINE_2, 15)]) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, now: () => SEEN_AT }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 2 });
    // LINE_1 was at revision 10, older than its unreadable 25: it goes.
    // LINE_2 was at 20, newer than its unreadable 15: it stays.
    expect(tables(db).lines).toEqual([{ id: LINE_2, name: "Линия 2", archived: 0, rev: 20 }]);
    expect(tables(db).state).toEqual(state(30));
    expect(quarantine(db)).toEqual([
      { entity: "lines", id: LINE_2, rev: 15, reason: "archived: invalid_type", seen_at: SEEN_AT },
      { entity: "lines", id: LINE_1, rev: 25, reason: "archived: invalid_type", seen_at: SEEN_AT },
    ]);
  });

  it("lifts a quarantine for a newer readable record or tombstone, never for an older one", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    await syncReferences({
      changes: feed({ 0: page(42, [broken, brokenLine(LINE_1, 42)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(2);

    // The host fixed the site; a tombstone older than the quarantined line
    // changes nothing.
    await expect(
      syncReferences({
        changes: feed({ 42: page(50, [{ ...SITE, rev: 45 }, tombstone(LINE_1, 40)]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 50, quarantined: 1 });
    expect(tables(db).site).toEqual([
      {
        id: "1",
        badge_salt: "AAECAwQFBgcICQoLDA0ODw==",
        box_block_size: 2000,
        pallet_block_size: 200,
        rev: 45,
      },
    ]);
    expect(quarantine(db)).toEqual([
      { entity: "lines", id: LINE_1, rev: 42, reason: "archived: invalid_type", seen_at: SEEN_AT },
    ]);

    // The host deleted the line.
    await expect(
      syncReferences({
        changes: feed({ 50: page(60, [tombstone(LINE_1, 55)]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 60, quarantined: 0 });
    expect(quarantine(db)).toEqual([]);
  });

  it("keeps one entry per record: a newer unreadable revision replaces it, the same page again does not", async () => {
    const { db, executor } = openLocalDb();
    const first = feed({ 0: page(42, [brokenLine(LINE_1, 42)]) });
    await syncReferences({ changes: first, local: executor, hostId: HOST_ID, now: () => SEEN_AT });
    // As if the revision were lost: the same page arrives again, later.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    await syncReferences({
      changes: first,
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT + 1000,
    });
    expect(quarantine(db)).toEqual([
      { entity: "lines", id: LINE_1, rev: 42, reason: "archived: invalid_type", seen_at: SEEN_AT },
    ]);

    const renamed: ChangeItem = {
      entity: "lines",
      id: LINE_1,
      rev: 50,
      deleted: false,
      data: { name: 7, archived: false },
    };
    await syncReferences({
      changes: feed({ 42: page(50, [renamed]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT + 2000,
    });
    expect(quarantine(db)).toEqual([
      {
        entity: "lines",
        id: LINE_1,
        rev: 50,
        reason: "name: invalid_type",
        seen_at: SEEN_AT + 2000,
      },
    ]);
  });

  it("builds the reason from issue paths and codes, never a value, in at most 200 characters", async () => {
    const { db, executor } = openLocalDb();
    const leaky: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 41,
      deleted: false,
      data: {
        name: 7,
        inn: "7701234567",
        gln: "4600682000013",
        gs1Prefixes: Array.from({ length: 30 }, () => 4607091),
        timeZone: "Europe/Moscow",
      },
    };
    const empty: ChangeItem = { entity: "lines", id: LINE_1, rev: 42, deleted: false };
    await syncReferences({
      changes: feed({ 0: page(42, [leaky, empty]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    const [lineEntry, orgEntry] = quarantine(db);
    expect(lineEntry).toMatchObject({ entity: "lines", reason: "data: invalid_type" });
    const reason = String(orgEntry?.reason);
    expect(reason).toHaveLength(200);
    expect(reason).toMatch(/^name: invalid_type; gs1Prefixes\.0: invalid_type; gs1Prefixes\.1: /);
    for (const value of ["7701234567", "4600682000013", "4607091", "Europe/Moscow"]) {
      expect(reason).not.toContain(value);
    }
  });

  it("clears the quarantine whenever the copies start from zero", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(42, [brokenLine(LINE_1, 42)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    // Written by the build before this one: the same entities, records of
    // the first version. A build that reads the record syncs from zero.
    db.prepare(
      "UPDATE sync_state SET value = 'org_profile,site,lines' WHERE key = 'entity_set'",
    ).run();
    const again = feed({ 0: page(43, [line(LINE_1, 43, "Линия 1")]) });
    await expect(
      syncReferences({ changes: again, local: executor, hostId: HOST_ID }),
    ).resolves.toEqual({ kind: "synced", rev: 43, quarantined: 0 });
    expect(again).toHaveBeenCalledWith(0);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 43 }]);
    expect(quarantine(db)).toEqual([]);

    // Paired with another host now, out of reach: the immediate wipe clears
    // the quarantine with the copies.
    await syncReferences({
      changes: feed({ 43: page(44, [brokenLine(LINE_2, 44)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(1);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: OTHER_HOST }),
    ).rejects.toThrow("host unreachable");
    expect(quarantine(db)).toEqual([]);
  });

  it("fits the worst-case page in one batch, within the shell's 32 statements", async () => {
    const { db, executor } = openLocalDb();
    const recorded = counting(executor);
    // A first sync (its first page carries the deferred wipe), and every
    // kept entity with a tombstone, a readable and an unreadable record.
    const items: ChangeItem[] = [
      { entity: "org_profile", id: "0", rev: 40, deleted: true },
      ORG,
      { ...ORG, id: "2", data: { name: "ООО «Атолл»" } },
      { entity: "site", id: "0", rev: 40, deleted: true },
      SITE,
      { ...SITE, id: "2", data: { badgeSalt: "short" } },
      tombstone(LINE_2, 40),
      line(LINE_1, 42, "Линия 1"),
      brokenLine("9b2e4a6c-0000-4000-8000-000000000000", 42),
    ];
    await expect(
      syncReferences({
        changes: feed({ 0: page(42, items) }),
        local: recorded.executor,
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 3 });
    // The `host_id` stamp, then the page: the guard, the wipe (3 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 3 + 6 = 15. Each new entity adds 3 (a wipe, a delete, an upsert),
    // so plan 1d3's operators and badges make it 21, within the shell's 32.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 15]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});

describe("sync scheduler", () => {
  it("runs one sync at a time and exactly once more for triggers during a run", async () => {
    const finish: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const scheduler = createSyncScheduler(run);
    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    finish[0]?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves a failed sync to the next trigger", async () => {
    const run = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("host unreachable"));
    run.mockResolvedValue(undefined);
    const scheduler = createSyncScheduler(run);
    scheduler.trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it("starts nothing after stop", async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = createSyncScheduler(run);
    scheduler.stop();
    scheduler.trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it("starts no further run after stop, even with a trigger queued during the run", async () => {
    const finish: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const scheduler = createSyncScheduler(run);
    scheduler.trigger(); // starts the one run
    scheduler.trigger(); // queues exactly one follow-up
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    finish[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

2. В `apps/standalone/test/local-executor.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "ref_site",
      "sync_state",
    ]);
```

заменить на

<!-- prettier-ignore -->
```ts
      "ref_site",
      "sync_quarantine",
      "sync_state",
    ]);
```

3. В `apps/standalone/test/api.test.ts` (тест ленты уходит из «HostApi office endpoints» в свой раздел — бриф, раздел 8; он проходит и до, и после) фрагмент

<!-- prettier-ignore -->
```ts
  it("reads the change feed with the device key only, no office session", async () => {
    const { api, sent } = recording(fixture("changes-response.json"));
    await expect(api.getChanges(41)).resolves.toMatchObject({ rev: 42, hasMore: false });
    expect(sent).toEqual([
      { method: "GET", path: "/v1/changes?since=41", body: undefined, officeToken: undefined },
    ]);
  });

  it("rejects a users answer that is not a list", async () => {
    const { api } = recording(fixture("office-user-record.json"));
    await expect(api.listUsers(TOKEN)).rejects.toThrow();
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
  it("rejects a users answer that is not a list", async () => {
    const { api } = recording(fixture("office-user-record.json"));
    await expect(api.listUsers(TOKEN)).rejects.toThrow();
  });
});

describe("HostApi change feed", () => {
  it("reads the change feed with the device key only, no office session", async () => {
    const { api, sent } = recording(fixture("changes-response.json"));
    await expect(api.getChanges(41)).resolves.toMatchObject({ rev: 42, hasMore: false });
    expect(sent).toEqual([
      { method: "GET", path: "/v1/changes?since=41", body: undefined, officeToken: undefined },
    ]);
  });
});
```

4. В `apps/standalone/test/shell.test.ts` (результат синхронизации в действиях редьюсера получает `quarantined`; без этого не пройдёт `typecheck`) фрагмент

<!-- prettier-ignore -->
```ts
      result: { kind: "synced", rev: 42 },
```

заменить на

<!-- prettier-ignore -->
```ts
      result: { kind: "synced", rev: 42, quarantined: 0 },
```

5. Там же фрагмент

<!-- prettier-ignore -->
```ts
      shellReducer(other, { type: "sync_finished", result: { kind: "synced", rev: 1 } }).sync,
```

заменить на

<!-- prettier-ignore -->
```ts
      shellReducer(other, {
        type: "sync_finished",
        result: { kind: "synced", rev: 1, quarantined: 0 },
      }).sync,
```

6. В `apps/standalone/src-tauri/tests/local_db.rs` (новая таблица в списке таблиц базы) фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(names, ["ref_lines", "ref_org", "ref_site", "sync_state"]);
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(
        names,
        [
            "ref_lines",
            "ref_org",
            "ref_site",
            "sync_quarantine",
            "sync_state"
        ]
    );
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/local-executor.test.ts test/api.test.ts`
Expected: FAIL — 19 тестов из 98:

- `local-executor.test.ts`, «has exactly the shell's reference tables»: в списке нет `sync_quarantine`;
- `reference-sync.test.ts`, 18 тестов:
  - `ENTITY_SET` — `'org_profile,site,lines'` вместо `'org_profile,site,lines;v2'`;
  - 6 тестов — результат без `quarantined` (`expected { kind: 'synced', rev: 42 } to deeply equal { kind: 'synced', rev: 42, …(1) }`);
  - тест гонки двух первых синхронизаций — `expected +0 to be 1` через секунду: прежний прогон не читает число записей в карантине, и третьего чтения нет;
  - повторная порция — `[ [ +0, +0, +0, +0, 3 ] ]` вместо `[ [ +0, +0, +0, +0, +0, 3 ] ]`;
  - два теста контракта ленты — `The instanceof assertion needs a constructor but undefined was given`;
  - 7 тестов карантина — прогон отвергает порцию: `unreadable site record 1` или `unreadable lines record …`;
- `api.test.ts` проходит: тест ленты только переехал.

Run: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`, затем `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline`
Expected: FAIL — `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`: `left: ["ref_lines", "ref_org", "ref_site", "sync_state"]`, в `right` есть `"sync_quarantine"`.

- [ ] **Step 3: Миграция и модуль синхронизации**

1. Create `apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql`:

```sql
-- Feed records the reference sync could not accept (stage 1 spec §5.4). A
-- record that fails its schema (damaged, or newer than this build reads) is
-- not applied, and an older local copy of it is deleted; it waits here until
-- the host changes it again or a build that reads it syncs from zero. The
-- webview's reference sync is the only writer. `reason` holds schema issue
-- paths and codes only, never a value; `seen_at` is Unix milliseconds on this
-- computer's clock.
CREATE TABLE sync_quarantine (
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  reason TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (entity, id)
);
```

2. Заменить содержимое `apps/standalone/src/local/reference-sync.ts` целиком:

```ts
import { z } from "zod";

import {
  lineRecordSchema,
  orgRecordSchema,
  siteRecordSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";

/**
 * `quarantined`: the feed records the copies hold in `sync_quarantine` after
 * this run, the ones from earlier runs included.
 */
export type SyncResult =
  { kind: "synced"; rev: number; quarantined: number } | { kind: "other_host" };

export interface SyncOptions {
  /** `GET /v1/changes?since=<rev>` (`HostApi.getChanges`). */
  changes: (since: number) => Promise<ChangesResponse>;
  local: LocalExecutor;
  /** The host this device is paired with (`DeviceStatus.hostId`). */
  hostId: string;
  /** Unix milliseconds for `sync_quarantine.seen_at`; this computer's clock unless a test pins it. */
  now?: () => number;
}

/**
 * The feed broke its own contract: the host went back twice in one run, or
 * a page claimed more without moving past the revision it was asked for.
 * A class of its own, so the shell can tell a feed failure from a host or a
 * local one.
 */
export class SyncFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncFeedError";
  }
}

/** A live record flattened for `upsert`, or why it fails its schema. */
type Checked = { row: Record<string, unknown> } | { reason: string };

interface EntityTable {
  table: string;
  /** Checks a live record: flattened with its key and revision, or the quarantine reason. */
  check: (item: ChangeItem) => Checked;
  /** Every accepted record of a page in one statement: `json_each` over the rows. */
  upsert: string;
}

/** The longest `sync_quarantine.reason`. */
const MAX_REASON_LENGTH = 200;

/**
 * Why a record fails its schema, from Zod issue paths and codes only
 * (`archived: invalid_type`; `data` names the record itself): never a value,
 * since operator records will carry PIN and badge hashes (plan 1d3).
 */
function quarantineReason(error: z.ZodError): string {
  const reason = error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "data" : issue.path.map(String).join(".");
      return `${path}: ${issue.code}`;
    })
    .join("; ");
  return reason.slice(0, MAX_REASON_LENGTH);
}

function checked<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  item: ChangeItem,
): Checked {
  const parsed = schema.safeParse(item.data);
  if (!parsed.success) return { reason: quarantineReason(parsed.error) };
  return { row: { ...parsed.data, id: item.id, rev: item.rev } };
}

const ENTITIES: ReadonlyMap<string, EntityTable> = new Map([
  [
    "org_profile",
    {
      table: "ref_org",
      check: (item) => checked(orgRecordSchema, item),
      // `->>` yields `gs1Prefixes` as the JSON text of the array.
      upsert:
        "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'inn', value ->> 'gln', " +
        "value ->> 'gs1Prefixes', value ->> 'timeZone', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, inn = excluded.inn, " +
        "gln = excluded.gln, gs1_prefixes = excluded.gs1_prefixes, " +
        "time_zone = excluded.time_zone, rev = excluded.rev " +
        "WHERE excluded.rev > ref_org.rev",
    },
  ],
  [
    "site",
    {
      table: "ref_site",
      check: (item) => checked(siteRecordSchema, item),
      upsert:
        "INSERT INTO ref_site (id, badge_salt, box_block_size, pallet_block_size, rev) " +
        "SELECT value ->> 'id', value ->> 'badgeSalt', value ->> 'boxBlockSize', " +
        "value ->> 'palletBlockSize', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET badge_salt = excluded.badge_salt, " +
        "box_block_size = excluded.box_block_size, " +
        "pallet_block_size = excluded.pallet_block_size, rev = excluded.rev " +
        "WHERE excluded.rev > ref_site.rev",
    },
  ],
  [
    "lines",
    {
      table: "ref_lines",
      // `->>` yields `archived` as 1 or 0.
      check: (item) => checked(lineRecordSchema, item),
      upsert:
        "INSERT INTO ref_lines (id, name, archived, rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, " +
        "rev = excluded.rev " +
        "WHERE excluded.rev > ref_lines.rev",
    },
  ],
]);

/**
 * The version of the kept records' schemas and of the copy tables' meaning.
 * Raise it whenever either changes: the stored `entity_set` then no longer
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 2;

/**
 * This build's copies, in `sync_state.entity_set`: the feed entities it
 * keeps (derived from `ENTITIES`, so a new entity cannot update that map and
 * forget this value, or the reverse) and `SYNC_SCHEMA_VERSION`. Today:
 * `"org_profile,site,lines;v2"`. A build that keeps other entities, or reads
 * them differently, finds another value there and syncs from zero: records
 * the old build skipped or quarantined would never come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys()].join(",")};v${SYNC_SCHEMA_VERSION}`;

/**
 * Deletes the rows that the page's tombstones and quarantined records are
 * newer than: an older one (the key was created again, or the copy is
 * already newer) leaves the row alone.
 */
function deleteOlder(table: string): string {
  return (
    `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(?) AS t ` +
    `WHERE t.value ->> 'id' = ${table}.id AND t.value ->> 'rev' > ${table}.rev)`
  );
}

/**
 * The page's quarantined records in one statement: a record already
 * quarantined is replaced only by a newer revision of it, so applying a page
 * again changes nothing. `seen_at` comes as a parameter, not from SQL.
 */
const QUARANTINE =
  "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
  "SELECT value ->> 'entity', value ->> 'id', value ->> 'rev', value ->> 'reason', ? " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT (entity, id) DO UPDATE SET rev = excluded.rev, reason = excluded.reason, " +
  "seen_at = excluded.seen_at " +
  "WHERE excluded.rev > sync_quarantine.rev";

/**
 * Lifts the quarantine of every record the page accepted or deleted, in one
 * statement: only for a revision at least the quarantined one, so an older
 * record never clears a newer quarantine.
 */
const LIFT_QUARANTINE =
  "DELETE FROM sync_quarantine WHERE EXISTS (SELECT 1 FROM json_each(?) AS t " +
  "WHERE t.value ->> 'entity' = sync_quarantine.entity " +
  "AND t.value ->> 'id' = sync_quarantine.id AND t.value ->> 'rev' >= sync_quarantine.rev)";

/** Every copy, the quarantine and the sync state: the next page applied starts from zero. */
const WIPE: readonly LocalStatement[] = [
  ...[...ENTITIES.values()].map((entity) => ({ sql: `DELETE FROM ${entity.table}` })),
  { sql: "DELETE FROM sync_quarantine" },
  { sql: "DELETE FROM sync_state" },
];

const WRITE_STATE =
  "INSERT INTO sync_state (key, value) VALUES ('last_rev', ?), ('host_id', ?), ('entity_set', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Stamps only `host_id`, with no `last_rev`: the immediate wipe for a new
 * host (`syncReferences`) must leave the copies looking unsynced, so
 * `readState` still starts the next page from zero and a stale in-flight
 * run for the old host is still caught by `hostGuard` below.
 */
const WRITE_HOST_ID =
  "INSERT INTO sync_state (key, value) VALUES ('host_id', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Aborts the batch (`changes_mismatch`) if another run has already
 * repointed `sync_state.host_id` away from `hostId` since this run read it.
 * A device can be re-paired while a run's request to the old host is still
 * in flight (up to 10 s); `SyncScheduler.stop` does not cancel that request,
 * so its page can arrive after a new run already wiped and restamped
 * `host_id` for the new host. Without this guard, that late page would
 * commit under the old host's higher revisions and win `excluded.rev > rev`
 * against the new host's rows — both hosts use the same ids (`'1'` for
 * `ref_org`/`ref_site`), so it would resurrect the old host's org and site
 * data. Placed first in every batch: a `DELETE FROM sync_state` later in
 * the same batch would remove the `host_id` row this statement reads.
 */
function hostGuard(hostId: string): LocalStatement {
  return {
    sql: "UPDATE sync_state SET value = value WHERE key = 'host_id' AND value <> ?",
    values: [hostId],
    expectedChanges: 0,
  };
}

const stateRow = z.object({ key: z.string(), value: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

interface StoredState {
  lastRev: number | null;
  hostId: string | null;
  entitySet: string | null;
}

async function readState(local: LocalExecutor): Promise<StoredState> {
  const rows = await local.query("SELECT key, value FROM sync_state", [], stateRow);
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  const rev = value("last_rev");
  return {
    lastRev: rev !== null && /^\d+$/.test(rev) ? Number(rev) : null,
    hostId: value("host_id"),
    entitySet: value("entity_set"),
  };
}

/**
 * One page's own statements: per entity one conditional delete for its
 * tombstones and quarantined records and one upsert for its accepted
 * records, then one quarantine upsert, one quarantine lift and the page's
 * revision. A record that fails its schema fails closed: it is not applied,
 * an older copy of it goes as if deleted, and it waits in `sync_quarantine`.
 * Entities this build does not keep are skipped, not quarantined.
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
 * statements — 15 today, 21 with plan 1d3's two entities, and E = 8 at most
 * within the shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
  const quarantined: Array<{ entity: string; id: string; rev: number; reason: string }> = [];
  const settled: Array<{ entity: string; id: string; rev: number }> = [];
  for (const [entity, table] of ENTITIES) {
    const older: Array<{ id: string; rev: number }> = [];
    const rows: Array<Record<string, unknown>> = [];
    for (const item of page.items) {
      if (item.entity !== entity) continue;
      const key = { id: item.id, rev: item.rev };
      if (item.deleted) {
        older.push(key);
        settled.push({ entity, ...key });
        continue;
      }
      const record = table.check(item);
      if ("row" in record) {
        rows.push(record.row);
        settled.push({ entity, ...key });
      } else {
        older.push(key);
        quarantined.push({ entity, ...key, reason: record.reason });
      }
    }
    if (older.length > 0) {
      statements.push({ sql: deleteOlder(table.table), values: [JSON.stringify(older)] });
    }
    if (rows.length > 0) statements.push({ sql: table.upsert, values: [JSON.stringify(rows)] });
  }
  if (quarantined.length > 0) {
    statements.push({ sql: QUARANTINE, values: [seenAt, JSON.stringify(quarantined)] });
  }
  if (settled.length > 0) {
    statements.push({ sql: LIFT_QUARANTINE, values: [JSON.stringify(settled)] });
  }
  statements.push({ sql: WRITE_STATE, values: [String(page.rev), hostId, ENTITY_SET] });
  return statements;
}

/**
 * Brings the local copies up to the host's revision (stage 1 spec §5.4):
 * pages of `GET /v1/changes` from the last applied revision until `hasMore`
 * is false, each page in one `local_transaction`. Applying a page again
 * changes nothing: a row changes only for a newer revision. Stops, applying
 * nothing, when the feed comes from another host than the paired one; a
 * feed that breaks its own contract fails the run with `SyncFeedError`.
 */
export async function syncReferences({
  changes,
  local,
  hostId,
  now = () => Date.now(),
}: SyncOptions): Promise<SyncResult> {
  const stored = await readState(local);
  let since = 0;
  let wipe = false;
  if (stored.hostId !== null && stored.hostId !== hostId) {
    // Copies from a pairing with another host must not stay usable while
    // this host is out of reach. No `last_rev` is written, so the copies
    // still read as unsynced afterwards (start from zero next time too),
    // and a stale in-flight run for the old host is still caught below by
    // `hostGuard`, bound to that old host's id, once it reaches its batch.
    await local.transaction([...WIPE, { sql: WRITE_HOST_ID, values: [hostId] }]);
  } else if (stored.entitySet === ENTITY_SET && stored.lastRev !== null) {
    since = stored.lastRev;
  } else {
    if (stored.hostId === null) {
      // No pairing recorded yet: there are never copies without a `host_id`,
      // so there is nothing to wipe, but the stamp itself cannot wait for
      // the first page. Without it, a concurrent first sync for a different
      // host that also reads no `host_id` takes this same branch, and
      // whichever of the two pages commits first passes `hostGuard` (it
      // finds no row to compare against) while the other — even though it
      // may be the pairing that is actually current — then fails its own
      // guard against the first one's stamp. Stamping up front means every
      // ordering has a `host_id` row in place before either page can land.
      await local.transaction([{ sql: WRITE_HOST_ID, values: [hostId] }]);
    }
    // Another build's entity set, or no sync yet: start from zero and drop
    // the old copies with the first page, so a failed fetch keeps them.
    wipe = true;
  }
  let wentBack = false;
  for (;;) {
    const page = await changes(since);
    if (page.hostId !== hostId) return { kind: "other_host" };
    if (page.rev < since) {
      // The host went back (restored from a copy): rows of the lost
      // revisions would block newer edits, so start again from zero.
      if (wentBack) {
        throw new SyncFeedError(`the host went back twice in one sync: ${page.rev} < ${since}`);
      }
      wentBack = true;
      since = 0;
      wipe = true;
      continue;
    }
    if (page.hasMore && page.rev <= since) {
      // `rev >= since` is established above, so this is `rev === since`:
      // the feed claims more pages without moving past the one just read.
      // Left unchecked, this would fetch and commit the same page forever.
      throw new SyncFeedError(
        `the feed made no progress at rev ${page.rev} while claiming more pages`,
      );
    }
    const statements = pageStatements(page, hostId, now());
    const batch = wipe
      ? [hostGuard(hostId), ...WIPE, ...statements]
      : [hostGuard(hostId), ...statements];
    await local.transaction(batch);
    wipe = false;
    since = page.rev;
    if (!page.hasMore) {
      const [count] = await local.query("SELECT count(*) AS n FROM sync_quarantine", [], countRow);
      return { kind: "synced", rev: page.rev, quarantined: count?.n ?? 0 };
    }
  }
}

export interface SyncScheduler {
  /** Sync now, or once more right after the sync in progress. */
  trigger: () => void;
  /** Start no sync after this one; a sync in progress finishes on its own. */
  stop: () => void;
}

/**
 * One sync at a time. Triggers during a run ask for exactly one more run
 * after it; a failed run just ends and waits for the next trigger. `run`
 * must report its own failure (a status field, a logged error, a toast):
 * this scheduler swallows every rejection and guarantees only the
 * single-flight-plus-one-follow-up scheduling, nothing about the outcome.
 */
export function createSyncScheduler(run: () => Promise<void>): SyncScheduler {
  let running = false;
  let again = false;
  let stopped = false;
  async function loop(): Promise<void> {
    running = true;
    try {
      do {
        again = false;
        try {
          await run();
        } catch {
          // The run reports its own failure; the next trigger tries again.
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  }
  return {
    trigger: () => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      void loop();
    },
    stop: () => {
      stopped = true;
    },
  };
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/local-executor.test.ts test/api.test.ts`
Expected: PASS — 29 тестов в `reference-sync.test.ts`, 54 в `local-executor.test.ts`, 15 в `api.test.ts` (98).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline`
Expected: PASS — 8 тестов (`build.rs` пересобрал оболочку с новой миграцией).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в конце раздела «Change feed», фрагмент

<!-- prettier-ignore -->
```text
On the device side a new entity also needs its entry in `ENTITIES`
(`src/local/reference-sync.ts`), which derives `ENTITY_SET`; a new entity
there changes `ENTITY_SET` and makes every device sync from zero once.
```

заменить на

<!-- prettier-ignore -->
```text
On the device side a new entity also needs its entry in `ENTITIES`
(`src/local/reference-sync.ts`), which derives `ENTITY_SET`; a new entity
there changes `ENTITY_SET` and makes every device sync from zero once. It
also adds three statements to the worst-case page batch (see "Reference
sync"), which must stay within the shell's 32.
```

2. Там же, в разделе «Reference sync», фрагмент

<!-- prettier-ignore -->
```text
page is one `local_transaction`: a `hostGuard` statement first (below),
then per entity one conditional delete for its tombstones (only rows older
than the tombstone) and one `json_each` upsert for its live records (only
when the revision is newer), then the page's revision. Records are checked
with their Zod schemas before anything is written, so a bad record leaves
the whole page unapplied; entities this build does not keep are skipped,
and applying a page again changes nothing. A page that claims `hasMore`
without moving past the revision it was fetched at is an error, not a
silent infinite loop.
The copies start from zero when `host_id` names another host, when
```

заменить на

<!-- prettier-ignore -->
```text
page is one `local_transaction`: a `hostGuard` statement first (below),
then per entity one conditional delete for its tombstones and quarantined
records (only rows older than them) and one `json_each` upsert for its
accepted records (only when the revision is newer), then one quarantine
upsert, one quarantine lift and the page's revision. Every live record is
checked with its Zod schema before anything is written. A record that
fails it (damaged, or newer than this build reads) fails closed (owner
decision 2026-09-27): it is not applied, its local copy goes if the
record's revision is newer (the tombstone rule), and it waits in
`sync_quarantine` while the rest of the page applies and the revision
advances. A newer readable record, or a tombstone at least as new, lifts
the quarantine; so does a build that reads the record, since it syncs
from zero. `reason` holds Zod issue paths and codes only
(`archived: invalid_type`, at most 200 characters), never a value:
operator records will carry PIN and badge hashes. `seen_at` is a
parameter from the webview's clock, never SQL time. Entities this build
does not keep are skipped, not quarantined, and applying a page again
changes nothing. A successful run reports the quarantine's size
(`quarantined`). A feed that breaks its own contract (it went back twice
in one run, or claims `hasMore` without moving past the revision it was
fetched at) fails the run with `SyncFeedError`, not a silent infinite
loop.
For E kept entities a page batch holds at most 3E + 6 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the quarantine upsert and lift, and the sync state. That
is 15 today and 21 with plan 1d3's operators and badges, within the
shell's 32 (E = 8 at most); a test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines;v2"`): raise the version whenever a record
schema or the meaning of a copy table changes, so every device syncs
from zero once and gets back what an older build quarantined or kept
differently.
The copies, and the quarantine with them, start from zero when `host_id`
names another host, when
```

3. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.3, фрагмент

<!-- prettier-ignore -->
```text
`rev`; `sync_state(key, value)` — последняя применённая ревизия и идентичность хоста.

План 1c создаёт `ref_org`, `ref_site`, `ref_lines` и `sync_state`; таблицы
операторов, бейджей, товаров и шаблонов добавляют планы 1d и 1e вместе со
своими сущностями ленты.
```

заменить на

<!-- prettier-ignore -->
```text
`rev`; `sync_state(key, value)` — последняя применённая ревизия и идентичность хоста;
`sync_quarantine(entity, id, rev, reason, seen_at)` — записи ленты, которые не прошли
свою схему (§5.4).

План 1c создаёт `ref_org`, `ref_site`, `ref_lines` и `sync_state`, план 1d1 —
`sync_quarantine`; таблицы операторов, бейджей, товаров и шаблонов добавляют
планы 1d и 1e вместе со своими сущностями ленты.
```

4. Там же, §5.4, фрагмент

<!-- prettier-ignore -->
```text
- удаление по записи `deleted` срабатывает, только если её ревизия новее ревизии
  строки: надгробие не удаляет ключ, созданный заново;
- копии начинаются с нуля, если `sync_state.host_id` называет другой хост (очистка
```

заменить на

<!-- prettier-ignore -->
```text
- удаление по записи `deleted` срабатывает, только если её ревизия новее ревизии
  строки: надгробие не удаляет ключ, созданный заново;
- запись, которая не прошла свою схему (повреждена или новее этой сборки), уходит
  в карантин `sync_quarantine` и не применяется (решение владельца 2026-09-27): её
  локальная копия удаляется, если ревизия записи новее ревизии строки, остальная
  порция применяется, ревизия продвигается. Причина — только пути и коды ошибок
  схемы, без значений. Запись выходит из карантина, когда хост меняет её снова
  (читаемая запись или удаление с ревизией не меньше) или когда сборка, которая её
  понимает, синхронизируется с нуля;
- сохранённый набор сущностей (`entity_set`) несёт и версию схемы записей
  (`org_profile,site,lines;v2`): смена схемы записи или смысла таблицы копий
  поднимает версию, и каждое устройство один раз синхронизируется с нуля;
- копии и карантин начинаются с нуля, если `sync_state.host_id` называет другой хост (очистка
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые TS и MD; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`
Expected: всё зелёное; Vitest — 28 файлов, 490 тестов.

```bash
git add apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/test/api.test.ts apps/standalone/test/shell.test.ts apps/standalone/src-tauri/tests/local_db.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): карантин записей ленты, которые не прошли свою схему" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Класс сбоя и повтор с отступом — `src/app/shell.ts`, `src/app/host-link.ts`

Сейчас неудачный прогон ждёт следующего события ревизии, а хост объявляет ревизию только при изменении данных: сбой может висеть часами. Хук связи начинает повторять неудачный прогон, пока связь `online`, а состояние синхронизации запоминает, почему прогон не удался. Экраны показывают это в задаче 3; здесь сбой виден через уже существующее сообщение выбора линии о сбое справочников.

Таймер повтора существует, только пока нет прогона, последний прогон не удался и связь на `online`. Поэтому его снимает начало любого прогона: ревизии, запроса или самого повтора. Раздельного снятия в каждом месте запуска не нужно.

**Files:**

- Modify: `apps/standalone/src/app/shell.ts`
- Modify (целиком): `apps/standalone/src/app/host-link.ts`, `apps/standalone/test/line-select.test.tsx`
- Create: `apps/standalone/test/host-link.test.ts`
- Modify: `apps/standalone/test/shell.test.ts`, `apps/standalone/test/app.test.tsx`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.4)

**Interfaces:**

- Consumes (задача 1): `SyncResult` с `quarantined`; `SyncFeedError` — `src/local/reference-sync.ts`. Кроме того: `HostError` (`src/host/client.ts`), `LocalDbError` (`src/local/executor.ts`), `shellActionFor` (`src/app/shell.ts`), `fakeConnection()` и `fakeHost()` (`test/app.test.tsx`).
- Produces:
  - `type SyncFailure = "host" | "local" | "feed"` — `src/app/shell.ts`;
  - `interface SyncState { kind: "idle" | "running" | "done" | "failed" | "other_host"; synced: number; failure: SyncFailure | null; quarantined: number }`;
  - действие `{ type: "sync_failed"; failure: SyncFailure }`;
  - `nextSyncRetryMs(attempt: number): number` и `syncFailureOf(error: unknown): SyncFailure` — `src/app/host-link.ts`;
  - `useHostLink(options: HostLinkOptions): () => void` — прежняя сигнатура;
  - тестовый помощник `hostDown(): HostError` на уровне модуля `test/app.test.tsx` — им пользуется задача 3.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/host-link.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { nextSyncRetryMs, syncFailureOf } from "../src/app/host-link.js";
import { HostError } from "../src/host/client.js";
import { LocalDbError } from "../src/local/executor.js";
import { SyncFeedError } from "../src/local/reference-sync.js";

describe("nextSyncRetryMs", () => {
  it("waits 2, 4, 8, 16 and 32 s, then 60 s before every later retry", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100].map((attempt) => nextSyncRetryMs(attempt))).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
});

describe("syncFailureOf", () => {
  it("blames the host, this computer or the feed", () => {
    expect(
      syncFailureOf(new HostError({ kind: "transport", code: "unreachable", message: "down" })),
    ).toBe("host");
    expect(
      syncFailureOf(new HostError({ kind: "api", code: "internal", status: 500, message: "oops" })),
    ).toBe("host");
    // The host answered, but not in a shape this build reads: the feed's failure.
    expect(
      syncFailureOf(
        new HostError({ kind: "transport", code: "invalid_response", message: "GET /v1/changes" }),
      ),
    ).toBe("feed");
    expect(syncFailureOf(new LocalDbError("statement_failed", "disk full"))).toBe("local");
    expect(syncFailureOf(new SyncFeedError("the host went back twice"))).toBe("feed");
    // Anything the run did not expect is the feed's to explain.
    expect(syncFailureOf(new Error("unexpected"))).toBe("feed");
  });
});
```

2. В `apps/standalone/test/shell.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  it("counts the syncs that brought the copies up to date", () => {
    const running = shellReducer(paired(), { type: "sync_started" });
    expect(running.sync).toEqual({ kind: "running", synced: 0 });
    const done = shellReducer(running, {
      type: "sync_finished",
      result: { kind: "synced", rev: 42, quarantined: 0 },
    });
    expect(done.sync).toEqual({ kind: "done", synced: 1 });
    const again = shellReducer(done, { type: "sync_started" });
    expect(again.sync).toEqual({ kind: "running", synced: 1 });
    expect(shellReducer(again, { type: "sync_failed" }).sync).toEqual({
      kind: "failed",
      synced: 1,
    });
  });
```

заменить на

<!-- prettier-ignore -->
```ts
  it("counts the syncs that brought the copies up to date", () => {
    const running = shellReducer(paired(), { type: "sync_started" });
    expect(running.sync).toEqual({ kind: "running", synced: 0, failure: null, quarantined: 0 });
    const done = shellReducer(running, {
      type: "sync_finished",
      result: { kind: "synced", rev: 42, quarantined: 0 },
    });
    expect(done.sync).toEqual({ kind: "done", synced: 1, failure: null, quarantined: 0 });
    const again = shellReducer(done, { type: "sync_started" });
    expect(again.sync).toEqual({ kind: "running", synced: 1, failure: null, quarantined: 0 });
    expect(shellReducer(again, { type: "sync_failed", failure: "host" }).sync).toEqual({
      kind: "failed",
      synced: 1,
      failure: "host",
      quarantined: 0,
    });
  });

  it("keeps why a sync failed through its retry, and the quarantine of the last success", () => {
    const failed = shellReducer(shellReducer(paired(), { type: "sync_started" }), {
      type: "sync_failed",
      failure: "host",
    });
    // The retry's run keeps the warning, so it does not flicker away.
    const retrying = shellReducer(failed, { type: "sync_started" });
    expect(retrying.sync).toEqual({ kind: "running", synced: 0, failure: "host", quarantined: 0 });
    const local = shellReducer(retrying, { type: "sync_failed", failure: "local" });
    expect(local.sync).toEqual({ kind: "failed", synced: 0, failure: "local", quarantined: 0 });
    const done = shellReducer(shellReducer(local, { type: "sync_started" }), {
      type: "sync_finished",
      result: { kind: "synced", rev: 43, quarantined: 2 },
    });
    expect(done.sync).toEqual({ kind: "done", synced: 1, failure: null, quarantined: 2 });
    // A later failure keeps the count the last successful run read.
    const feed = shellReducer(shellReducer(done, { type: "sync_started" }), {
      type: "sync_failed",
      failure: "feed",
    });
    expect(feed.sync).toEqual({ kind: "failed", synced: 1, failure: "feed", quarantined: 2 });
  });
```

3. Там же фрагмент

<!-- prettier-ignore -->
```ts
    expect(other.sync).toEqual({ kind: "other_host", synced: 0 });
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(other.sync).toEqual({ kind: "other_host", synced: 0, failure: null, quarantined: 0 });
```

4. Там же фрагмент

<!-- prettier-ignore -->
```ts
    expect(shellReducer(other, { type: "sync_failed" }).sync).toEqual(other.sync);
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(shellReducer(other, { type: "sync_failed", failure: "host" }).sync).toEqual(other.sync);
```

5. Там же фрагмент

<!-- prettier-ignore -->
```ts
    expect(shellReducer(other, { type: "forgotten" }).sync).toEqual({ kind: "idle", synced: 0 });
    expect(shellReducer(other, { type: "paired", status: DEVICE_STATUS }).sync).toEqual({
      kind: "idle",
      synced: 0,
    });
```

заменить на

<!-- prettier-ignore -->
```ts
    const idle = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
    expect(shellReducer(other, { type: "forgotten" }).sync).toEqual(idle);
    expect(shellReducer(other, { type: "paired", status: DEVICE_STATUS }).sync).toEqual(idle);
```

6. Там же фрагмент

<!-- prettier-ignore -->
```ts
    expect(forgotten.sync).toEqual({ kind: "idle", synced: 0 });
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(forgotten.sync).toEqual({ kind: "idle", synced: 0, failure: null, quarantined: 0 });
```

7. Там же фрагмент

<!-- prettier-ignore -->
```ts
      sync: { kind: "done", synced: 1 },
```

заменить на

<!-- prettier-ignore -->
```ts
      sync: { kind: "failed", synced: 1, failure: "feed", quarantined: 3 },
```

8. Там же фрагмент

<!-- prettier-ignore -->
```ts
    expect(next.sync).toEqual({ kind: "idle", synced: 0 });
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(next.sync).toEqual({ kind: "idle", synced: 0, failure: null, quarantined: 0 });
```

Тест выбора линии получает помощник `syncState`: у `SyncState` теперь четыре поля. Поведение его тестов не меняется.

9. Заменить содержимое `apps/standalone/test/line-select.test.tsx` целиком:

```tsx
import type { DatabaseSync } from "node:sqlite";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LineSelect, type LineSelectProps } from "../src/app/LineSelect.js";
import type { SyncState } from "../src/app/shell.js";
import { DeviceError } from "../src/host/device.js";
import { openLocalDb } from "./support/local-db.js";

const LINE_2 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_10 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const OLD_LINE = "9b2e4a6c-0000-4000-8000-000000000000";

function insertLine(db: DatabaseSync, id: string, name: string, archived = 0): void {
  db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, 1)").run(
    id,
    name,
    archived,
  );
}

/** A sync state with no failure and nothing quarantined. */
function syncState(kind: SyncState["kind"], synced: number): SyncState {
  return { kind, synced, failure: null, quarantined: 0 };
}

function renderLineSelect(sync: SyncState, overrides: Partial<LineSelectProps> = {}) {
  const { db, executor } = openLocalDb();
  const props: LineSelectProps = {
    local: executor,
    sync,
    link: null,
    onSelect: vi.fn<LineSelectProps["onSelect"]>(async () => undefined),
    onSync: vi.fn<LineSelectProps["onSync"]>(),
    onOffice: vi.fn<LineSelectProps["onOffice"]>(),
    ...overrides,
  };
  return { db, props, view: render(<LineSelect {...props} />) };
}

describe("LineSelect", () => {
  it("waits for a sync in this session before it reads the lines", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0));
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} />);
    // Flush the microtask a query would resolve on, so a guard that failed
    // to skip the read would actually show up before the assertions run.
    await act(async () => {});
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull();
  });

  it("lists the active lines by name once the copies are up to date", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0));
    insertLine(db, LINE_10, "Линия 10");
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, OLD_LINE, "Старая линия", 1);
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    await screen.findByRole("button", { name: "Линия 2" });
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((name) => name?.startsWith("Линия"));
    expect(names).toEqual(["Линия 2", "Линия 10"]);
    expect(screen.queryByRole("button", { name: "Старая линия" })).toBeNull();
  });

  it("explains a failed first sync and syncs again on request", () => {
    const { props } = renderLineSelect(syncState("failed", 0));
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("says when the host has no active lines", async () => {
    renderLineSelect(syncState("done", 1));
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });

  it("chooses a line with the host", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0));
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(LINE_2));
  });

  it("explains a line the host refused, syncs and reads the lines again", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("line_rejected", "archived meanwhile");
    });
    const { db, props, view } = renderLineSelect(syncState("running", 0), { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, LINE_10, "Линия 10");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(
      await screen.findByText(
        "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      ),
    ).toBeTruthy();
    expect(props.onSync).toHaveBeenCalledTimes(1);

    // The sync brings the archive flag; the list follows it.
    db.prepare("UPDATE ref_lines SET archived = 1 WHERE id = ?").run(LINE_2);
    view.rerender(<LineSelect {...props} sync={syncState("done", 2)} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull());
    expect(screen.getByRole("button", { name: "Линия 10" })).toBeTruthy();
  });

  it("explains an unreachable host in words true for a remote station too", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("unreachable", "host down");
    });
    const { db, props, view } = renderLineSelect(syncState("running", 0), { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    // Not "Служба хоста на этом компьютере не отвечает.": this station's
    // paired host can be a different PC on the network.
    expect(await screen.findByText("Хост не отвечает.")).toBeTruthy();
    expect(screen.queryByText("Служба хоста на этом компьютере не отвечает.")).toBeNull();
  });

  it("explains any other refusal without syncing", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("request_failed", "host error");
    });
    const { db, props, view } = renderLineSelect(syncState("running", 0), { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(await screen.findByText("Хост не выполнил запрос. Повторите попытку.")).toBeTruthy();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it("shows the link and opens the office", () => {
    const { props } = renderLineSelect(syncState("failed", 0), {
      link: { state: "offline", lastContactAt: null, lastError: "unreachable", seq: 4 },
    });
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(props.onOffice).toHaveBeenCalledTimes(1);
  });
});
```

В `test/app.test.tsx` — помощник `hostDown` на уровне модуля, проверка «ровно один раз» в двух тестах первой синхронизации (бриф, раздел 8) и раздел «reference sync retries» в конце файла.

10. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { describe, expect, it, vi } from "vitest";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
```

11. Там же фрагмент

<!-- prettier-ignore -->
```tsx
function lineItem(rev: number, name: string): ChangeItem {
  return { entity: "lines", id: LINE_ID, rev, deleted: false, data: { name, archived: false } };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
function lineItem(rev: number, name: string): ChangeItem {
  return { entity: "lines", id: LINE_ID, rev, deleted: false, data: { name, archived: false } };
}

/** The feed's request did not reach the host. */
function hostDown(): HostError {
  return new HostError({ kind: "transport", code: "unreachable", message: "host down" });
}
```

12. Там же, в тесте «still syncs once when the link's watch itself fails, and reaches the floor», фрагмент

<!-- prettier-ignore -->
```tsx
    // The sync starts in the link effect, which runs after the floor shows.
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    // The sync starts in the link effect, which runs after the floor shows.
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
    // Exactly once: settle, then check again. React runs passive effects in
    // `setImmediate` tasks, which `waitFor`'s `setTimeout(0)` does not wait for.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });
```

13. Там же, в тесте «syncs only after watch settles, not before, …», фрагмент

<!-- prettier-ignore -->
```tsx
    resolveWatch?.(() => undefined);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    resolveWatch?.(() => undefined);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
    // Exactly once: settle, then check again (see the test above).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });
```

14. Там же, в конце файла, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByRole("button", { name: "Подключиться к хосту в сети" })).toBeNull();
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByRole("button", { name: "Подключиться к хосту в сети" })).toBeNull();
  });
});

describe("reference sync retries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Only `setTimeout` is fake, and it also advances with real time: React's
   * scheduler (`setImmediate`) and Testing Library's polling stay real, and
   * `elapse` jumps the retry waits.
   */
  function fakeRetryTimers(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  }

  /** Moves the clock on by `ms`; what the timers set off settles inside `act`. */
  async function elapse(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** The station without a line says the first sync failed. */
  async function firstSyncFailed(): Promise<void> {
    expect(await screen.findByText("Не удалось получить справочники с хоста.")).toBeTruthy();
  }

  it("retries a failed sync after 2 s, then after 4 s, while the link is online", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges
      .mockRejectedValueOnce(hostDown())
      .mockRejectedValueOnce(hostDown())
      .mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    await elapse(1000);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    await elapse(1500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    // The second failure in a row waits twice as long.
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole("button", { name: "Линия 1" })).toBeTruthy();
  });

  it("stops retrying once a sync succeeds", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the pending retry while the link is down and syncs at once when it is back", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(NEW_STATION),
      host,
      connection: link.connection,
    });
    await firstSyncFailed();
    expect(vi.getTimerCount()).toBe(1);
    await link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "unreachable",
      seq: 2,
    });
    expect(vi.getTimerCount()).toBe(0);
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    // Back online: no need to wait for the next revision event.
    await link.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });

  it("syncs at once on a revision, dropping the pending retry", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown()).mockRejectedValueOnce(hostDown());
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(NEW_STATION),
      host,
      connection: link.connection,
    });
    await firstSyncFailed();
    await link.revision(43);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    // The second failure in a row waits 4 s; the first one's 2 s wait is gone.
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
  });

  it("leaves no retry behind when the app unmounts", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    const view = renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });

  it("leaves no retry behind when a retry finds another host", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges
      .mockRejectedValueOnce(hostDown())
      .mockResolvedValueOnce(feedPage(7, [], OTHER_HOST_ID));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    await elapse(2500);
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link.test.ts test/app.test.tsx test/line-select.test.tsx`
Expected: FAIL — 13 тестов из 92:

- `host-link.test.ts`, оба: `nextSyncRetryMs is not a function`, `syncFailureOf is not a function`;
- `shell.test.ts`, 5 тестов: в объектах `sync` нет `failure` и `quarantined` (`expected { kind: 'running', synced: +0 } to deeply equal { kind: 'running', synced: +0, …(2) }`);
- `app.test.tsx`, все 6 тестов «reference sync retries», повтора нет:
  - `expected "vi.fn()" to be called 2 times, but got 1 times` — два теста;
  - `expected "vi.fn()" to be called 3 times, but got 2 times` — тест ревизии;
  - `expected +0 to be 1` у `vi.getTimerCount()` — два теста;
  - «Unable to find an element with the text: Устройство подключено к другому хосту» — тест другого хоста;
- `line-select.test.tsx` проходит: он только переехал на помощник.

- [ ] **Step 3: Класс сбоя в состоянии и повтор в хуке**

1. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
/**
 * The reference sync (`src/local/reference-sync.ts`): what the latest run
 * is doing or how it ended, and how many runs brought the local copies up
 * to date since the pairing, so a screen reading them knows when to read
 * again.
 */
export interface SyncState {
  kind: "idle" | "running" | "done" | "failed" | "other_host";
  synced: number;
}
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * Why a reference sync failed: the host did not answer the request
 * (`HostError`), this computer could not write its copies (`LocalDbError`),
 * or the host's feed could not be applied (an answer this build cannot read,
 * a `SyncFeedError`, anything else).
 */
export type SyncFailure = "host" | "local" | "feed";

/**
 * The reference sync (`src/local/reference-sync.ts`): what the latest run
 * is doing or how it ended; how many runs brought the local copies up to
 * date since the pairing, so a screen reading them knows when to read
 * again; why the last failed run failed, kept through the retry's own run
 * until one succeeds; and how many feed records the copies hold in
 * quarantine, as the last successful run counted them.
 */
export interface SyncState {
  kind: "idle" | "running" | "done" | "failed" | "other_host";
  synced: number;
  failure: SyncFailure | null;
  quarantined: number;
}
```

2. Там же фрагмент

<!-- prettier-ignore -->
```ts
  | { type: "sync_failed" }
```

заменить на

<!-- prettier-ignore -->
```ts
  | { type: "sync_failed"; failure: SyncFailure }
```

3. Там же фрагмент

<!-- prettier-ignore -->
```ts
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0 };
```

заменить на

<!-- prettier-ignore -->
```ts
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
```

4. Там же, в `shellReducer`, фрагмент

<!-- prettier-ignore -->
```ts
      // scheduler as soon as a run finds `other_host` or a rejection, but a
      // run already queued by a revision can still land here first.
      if (state.sync.kind === "other_host") return state;
```

заменить на

<!-- prettier-ignore -->
```ts
      // scheduler as soon as a run finds `other_host` or a rejection, but a
      // run already queued by a revision can still land here first. A
      // retry keeps the last failure, so the warning does not flicker.
      if (state.sync.kind === "other_host") return state;
```

5. Там же фрагмент

<!-- prettier-ignore -->
```ts
      return { ...state, sync: { kind: "done", synced: state.sync.synced + 1 } };
    case "sync_failed":
      if (state.sync.kind === "other_host") return state;
      return { ...state, sync: { ...state.sync, kind: "failed" } };
```

заменить на

<!-- prettier-ignore -->
```ts
      return {
        ...state,
        sync: {
          kind: "done",
          synced: state.sync.synced + 1,
          failure: null,
          quarantined: action.result.quarantined,
        },
      };
    case "sync_failed":
      if (state.sync.kind === "other_host") return state;
      return { ...state, sync: { ...state.sync, kind: "failed", failure: action.failure } };
```

6. Заменить содержимое `apps/standalone/src/app/host-link.ts` целиком:

```ts
import { useCallback, useEffect, useRef } from "react";

import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import type { ChangesResponse } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import { createSyncScheduler, syncReferences } from "../local/reference-sync.js";
import { shellActionFor, type ShellAction, type SyncFailure } from "./shell.js";

/** The waits before the first retries of a failed sync, in milliseconds. */
const RETRY_MS = [2000, 4000, 8000, 16000, 32000] as const;
/** The wait before every later retry. */
const RETRY_CAP_MS = 60_000;

/**
 * How long to wait before retrying after `attempt` failed runs in a row (1
 * after the first): 2 s, 4 s, 8 s, 16 s, 32 s, then 60 s for every later one.
 */
export function nextSyncRetryMs(attempt: number): number {
  return RETRY_MS[attempt - 1] ?? RETRY_CAP_MS;
}

/**
 * Why a run failed, for the status line: the host did not answer (a
 * `HostError`), this computer could not write (`LocalDbError`), or the feed
 * could not be applied — an answer from the host this build cannot read
 * (`HostError` `invalid_response`), a `SyncFeedError`, and anything else the
 * run did not expect.
 */
export function syncFailureOf(error: unknown): SyncFailure {
  if (error instanceof HostError) {
    return error.kind === "transport" && error.code === "invalid_response" ? "feed" : "host";
  }
  if (error instanceof LocalDbError) return "local";
  return "feed";
}

export interface HostLinkOptions {
  /** The paired host; `null` while unpaired, rejected or stopped at another host. */
  hostId: string | null;
  connection: ConnectionApi;
  local: LocalExecutor;
  /** `HostApi.getChanges`. */
  changes: (since: number) => Promise<ChangesResponse>;
  dispatch: (action: ShellAction) => void;
}

/**
 * While a host is paired: follows the shell's link to it and keeps the local
 * reference copies in step with a sync once `watch` has subscribed (or
 * failed to) and after every revision event. The first event after each
 * reconnect carries the host's current revision, so catching up needs
 * nothing more. A failed run — not another host, not a rejected device — is
 * retried while the link is online, after `nextSyncRetryMs`; a lost link
 * drops the pending retry, and the link coming back syncs at once. Returns
 * a function that asks for a sync now.
 */
export function useHostLink({
  hostId,
  connection,
  local,
  changes,
  dispatch,
}: HostLinkOptions): () => void {
  const syncNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (hostId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
    let active = true;
    // The link's latest status is `online`: only then is a retry worth it.
    let online = false;
    let running = false;
    // Failed runs in a row; a successful run starts the count again.
    let failures = 0;
    // The pending retry. It exists only while no run is in flight, the last
    // run failed and the link is online.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const cancelRetry = () => {
      if (retry === null) return;
      clearTimeout(retry);
      retry = null;
    };
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
      // Any run — a revision's, a request's or the retry itself — replaces
      // the pending retry.
      cancelRetry();
      running = true;
      dispatch({ type: "sync_started" });
      try {
        const result = await syncReferences({ changes, local, hostId });
        if (!active) return;
        failures = 0;
        if (result.kind === "other_host") {
          // A run a revision already queued during this one must not also
          // reach that host: the effect's cleanup (`active = false`, which
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          scheduler.stop();
        }
        dispatch({ type: "sync_finished", result });
      } catch (error) {
        if (!active) return;
        // A rejected key or a changed certificate needs a new pairing.
        const action = shellActionFor(error, null);
        if (action) {
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          scheduler.stop();
          dispatch(action);
        }
        dispatch({ type: "sync_failed", failure: syncFailureOf(error) });
        if (action === null) {
          failures += 1;
          if (online) {
            retry = setTimeout(() => {
              retry = null;
              scheduler.trigger();
            }, nextSyncRetryMs(failures));
          }
        }
      } finally {
        running = false;
      }
    });
    syncNow.current = scheduler.trigger;
    let unwatch: (() => void) | null = null;
    connection
      .watch({
        onStatus: (status) => {
          if (!active) return;
          dispatch({ type: "link_status", status });
          online = status.state === "online";
          if (!online) {
            // Nothing to retry against: the first revision event after the
            // reconnect syncs again.
            cancelRetry();
          } else if (failures > 0 && !running && retry === null) {
            // Back online after a failed run whose retry the lost link
            // dropped: no need to wait for the revision event.
            scheduler.trigger();
          }
        },
        onRevision: (rev) => {
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          scheduler.trigger();
        },
      })
      .then(
        (stop) => {
          if (!active) {
            stop();
            return;
          }
          unwatch = stop;
          // Sync only now: revisions announced before `watch` resolved are
          // not replayed, so a sync started earlier could miss a commit that
          // landed between its fetch and the listener.
          scheduler.trigger();
        },
        () => {
          // Without events the copies still sync once here and on request.
          if (active) scheduler.trigger();
        },
      );
    return () => {
      active = false;
      syncNow.current = () => undefined;
      scheduler.stop();
      cancelRetry();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link.test.ts test/app.test.tsx test/line-select.test.tsx`
Expected: PASS — 35 тестов в `shell.test.ts`, 2 в `host-link.test.ts`, 46 в `app.test.tsx`, 9 в `line-select.test.tsx` (92).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «App shell», фрагмент

<!-- prettier-ignore -->
```text
to another host (`other_host`, which only a new pairing clears). A link
`lastError` of `key_rejected` or `certificate_mismatch` is a rejected
device, exactly like the same answer to an office call. A new revision
```

заменить на

<!-- prettier-ignore -->
```text
to another host (`other_host`, which only a new pairing clears). A failed
run (neither another host nor a rejected device) is retried while the link
is online: after 2, 4, 8, 16 and 32 s, then every 60 s (`nextSyncRetryMs`).
A successful run starts the count again, any other run replaces the
pending retry, a status that is not `online` drops it, and an `online`
status after a failed run whose retry was dropped syncs at once. The
run's error sets the sync state's `failure`: `local` for a
`LocalDbError`; `feed` for an answer this build cannot read (a
`HostError` with code `invalid_response`), a `SyncFeedError` or anything
else; `host` for every other `HostError`. It stays through the retry's
own run, so a warning does not flicker; a successful run clears it and
sets `quarantined`. A link
`lastError` of `key_rejected` or `certificate_mismatch` is a rejected
device, exactly like the same answer to an office call. A new revision
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.4, фрагмент

<!-- prettier-ignore -->
```text
- синхронизации не идут параллельно: событие во время прогона запрашивает ровно один
  следующий прогон, неудачный прогон ждёт следующего события.
```

заменить на

<!-- prettier-ignore -->
```text
- синхронизации не идут параллельно: событие во время прогона запрашивает ровно один
  следующий прогон. Неудачный прогон (не другой хост и не отказ устройства)
  повторяется, пока связь с хостом жива: через 2, 4, 8, 16, 32 с, дальше каждые
  60 с. Удачный прогон сбрасывает отсчёт; событие ревизии или запрос синхронизации
  запускают прогон сразу; потеря связи отменяет ожидающий повтор, а связь,
  восстановленная после неудачи, запускает прогон сразу.
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые TS, TSX и MD; `git diff --check`
Expected: всё зелёное; Vitest — 29 файлов, 499 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose`
Expected: один раз, чтобы увидеть весь вывод: 499 тестов PASS, в stderr пусто (нет предупреждений `act(...)`).

```bash
git add apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/test/host-link.test.ts apps/standalone/test/shell.test.ts apps/standalone/test/line-select.test.tsx apps/standalone/test/app.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): класс сбоя синхронизации и повтор с отступом, пока хост на связи" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Сбой и карантин на экранах — `HostStatusLine`, цех, выбор линии, шапка офиса

Строка связи получает состояние синхронизации и в той же вежливой живой области показывает два предупреждения — тег фазы `attention` со словами. Первое — пока связь `online`, если последний прогон не удался: «Справочники не обновились — повторим автоматически» и причина по классу сбоя. Второе — при любой связи, если в карантине есть записи: «Не приняты записи справочников: N». Без связи о сбое говорит сама строка связи, а повтор ждёт её, поэтому предупреждение о сбое скрыто.

Шапка офиса получает состояние синхронизации через `OfficeLinkProvider`: его значение расширено до `{ status, sync }`. Это меньше, чем второй провайдер: `useOfficeLink` читает только `OfficeShell`.

Выбор линии объясняет последний сбой (мелкое замечание 9 итогового ревью 1c3):

- синхронизация не удалась после последнего чтения — текст по классу сбоя: `host` — прежний текст о хосте, `local` и `feed` — те же слова, что у строки связи (ключи `errors.sync.local` и `errors.sync.feed`, в `ru.json` каждый текст один раз);
- чтение своей копии не удалось после последней синхронизации — «Не удалось прочитать справочники на этом компьютере.»;
- пока идёт синхронизация, в том числе повтор, — индикатор вместо старого сообщения.

**Files:**

- Modify (целиком): `apps/standalone/src/app/HostStatusLine.tsx`, `apps/standalone/src/office/office-link.tsx`, `apps/standalone/test/host-status-line.test.tsx`
- Modify: `apps/standalone/src/app/screens.tsx`, `apps/standalone/src/app/LineSelect.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/office/OfficeShell.tsx`
- Modify: `apps/standalone/test/line-select.test.tsx`, `apps/standalone/test/app.test.tsx`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.1)

**Interfaces:**

- Consumes (задача 2): `SyncState`, `SyncFailure` — `src/app/shell.ts`; `hostDown()`, `fakeConnection()`, `signIn()` — `test/app.test.tsx`; `syncState(kind, synced)` — `test/line-select.test.tsx`.
- Produces:
  - `interface HostStatusLineProps { status: HostStatus | null; sync: SyncState | null }` и `HostStatusLine(props: HostStatusLineProps)`;
  - `FloorScreen({ link, sync, onOffice }: { link: HostStatus | null; sync: SyncState; onOffice: () => void })`;
  - `OfficeProps.sync?: SyncState | null`;
  - `interface OfficeLink { status: HostStatus | null; sync: SyncState | null }`, `OfficeLinkProvider({ value: OfficeLink })`, `useOfficeLink(): OfficeLink`;
  - ключи `link.syncFailed`, `link.quarantined`, `errors.sync.host|local|feed`, `shell.lineSelect.readFailed`;
  - классы `.host-status` (колонка строк) и `.host-status__line` (строка тега и причины).

- [ ] **Step 1: Тесты (падающие)**

Тест строки связи переписан целиком: прежние тесты получают `sync={null}`, новые проверяют:

- предупреждение для каждого класса сбоя в живой области;
- предупреждение во время повтора;
- его отсутствие без связи;
- число в карантине при любой связи;
- тишину, когда копии в порядке.

Тест выбора линии получает пять тестов: объяснение неудачной синхронизации для `local` и `feed`, сбой чтения своей копии, индикатор во время повтора и последний из двух сбоев.

1. Заменить содержимое `apps/standalone/test/host-status-line.test.tsx` целиком:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostStatusLine } from "../src/app/HostStatusLine.js";
import type { SyncFailure, SyncState } from "../src/app/shell.js";
import { hostStatusSchema, type HostStatus } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";

/** 14:05 on this computer's clock, whatever its time zone. */
const AT_14_05 = new Date(2026, 8, 27, 14, 5).getTime();
/** 14:05 the day before `AT_14_05`, same clock. */
const YESTERDAY_AT_14_05 = new Date(2026, 8, 26, 14, 5).getTime();

const SYNC_FAILED = "Справочники не обновились — повторим автоматически";

function status(overrides: Partial<HostStatus>): HostStatus {
  return { state: "online", lastContactAt: AT_14_05, lastError: null, seq: 1, ...overrides };
}

function sync(overrides: Partial<SyncState>): SyncState {
  return { kind: "done", synced: 1, failure: null, quarantined: 0, ...overrides };
}

describe("HostStatusLine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the host is online, politely for screen readers", () => {
    render(<HostStatusLine status={status({})} sync={null} />);
    const line = screen.getByText("На связи с хостом").closest(".host-status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.getAttribute("role")).toBe("status");
  });

  it("says since when the host is silent and why, on the same day", () => {
    // "Now" pinned to the same local day as `AT_14_05`, so this test does not
    // depend on the real date the suite happens to run on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 18, 30));
    render(
      <HostStatusLine
        status={status({ state: "offline", lastError: "unreachable" })}
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом с 14:05")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("adds the date when the last contact fell on an earlier local day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 9, 0));
    render(
      <HostStatusLine
        status={status({
          state: "offline",
          lastError: "unreachable",
          lastContactAt: YESTERDAY_AT_14_05,
        })}
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом с 26.09 14:05")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("shows the date when the last contact was the same day of an earlier month", () => {
    // A day-of-month-only comparison (27 == 27) would wrongly call this
    // "today" and hide the date: 27 August is not 27 September.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 9, 0));
    const lastMonthSameDate = new Date(2026, 7, 27, 14, 5).getTime();
    render(
      <HostStatusLine
        status={status({
          state: "offline",
          lastError: "unreachable",
          lastContactAt: lastMonthSameDate,
        })}
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом с 27.08 14:05")).toBeTruthy();
  });

  it("says it is connecting and why the last attempt failed", () => {
    render(
      <HostStatusLine
        status={status({ state: "connecting", lastError: "stream_ended" })}
        sync={null}
      />,
    );
    expect(screen.getByText("Подключение к хосту…")).toBeTruthy();
    expect(screen.getByText("Связь с хостом прервалась.")).toBeTruthy();
  });

  it("says the host is silent when it never answered", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "key_rejected" })}
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не принимает это устройство.")).toBeTruthy();
  });

  it("has a text for every reason the shell reports", () => {
    const reasons = hostStatusSchema.shape.lastError.unwrap().options;
    expect(reasons).toHaveLength(5);
    for (const reason of reasons) {
      expect(i18n.exists(`errors.link.${reason}`), reason).toBe(true);
    }
  });

  it("renders the live region empty before the first status, so a screen reader already watches it", () => {
    const { container } = render(<HostStatusLine status={null} sync={null} />);
    const line = container.querySelector(".host-status");
    expect(line).toBeTruthy();
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.textContent).toBe("");
  });

  it.each<[SyncFailure, string]>([
    ["host", "Хост не ответил на запрос."],
    ["local", "Не удалось записать справочники на этом компьютере."],
    ["feed", "Ленту изменений хоста не удалось применить."],
  ])(
    "warns while the host answers that the copies did not update (%s), in the live region",
    (failure, reason) => {
      render(<HostStatusLine status={status({})} sync={sync({ kind: "failed", failure })} />);
      const warning = screen.getByText(SYNC_FAILED);
      expect(warning.closest(".host-status")?.getAttribute("aria-live")).toBe("polite");
      expect(screen.getByText(reason)).toBeTruthy();
    },
  );

  it("keeps the warning through the retry's own run", () => {
    render(
      <HostStatusLine status={status({})} sync={sync({ kind: "running", failure: "host" })} />,
    );
    expect(screen.getByText(SYNC_FAILED)).toBeTruthy();
  });

  it("leaves a failed sync to the link's own words while the host is away", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "unreachable" })}
        sync={sync({ kind: "failed", failure: "host" })}
      />,
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.queryByText(SYNC_FAILED)).toBeNull();
  });

  it("counts the records the copies did not accept, with the host or without it", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "unreachable" })}
        sync={sync({ quarantined: 3 })}
      />,
    );
    const count = screen.getByText("Не приняты записи справочников: 3");
    expect(count.closest(".host-status")?.getAttribute("role")).toBe("status");
  });

  it("says nothing more while the copies are up to date", () => {
    render(<HostStatusLine status={status({})} sync={sync({})} />);
    expect(screen.getByText("На связи с хостом")).toBeTruthy();
    expect(screen.queryByText(SYNC_FAILED)).toBeNull();
    expect(screen.queryByText(/Не приняты записи справочников/)).toBeNull();
  });
});
```

2. В `apps/standalone/test/line-select.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { SyncState } from "../src/app/shell.js";
import { DeviceError } from "../src/host/device.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { SyncFailure, SyncState } from "../src/app/shell.js";
import { DeviceError } from "../src/host/device.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
```

3. Там же фрагмент

<!-- prettier-ignore -->
```tsx
const OLD_LINE = "9b2e4a6c-0000-4000-8000-000000000000";
```

заменить на

<!-- prettier-ignore -->
```tsx
const OLD_LINE = "9b2e4a6c-0000-4000-8000-000000000000";

/** Copies this computer cannot read. */
const UNREADABLE: LocalExecutor = {
  query: () => Promise.reject(new LocalDbError("statement_failed", "disk I/O error")),
  transaction: () => Promise.reject(new LocalDbError("statement_failed", "disk I/O error")),
};
```

4. Там же фрагмент

<!-- prettier-ignore -->
```tsx
  it("says when the host has no active lines", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
  it.each<[SyncFailure, string]>([
    ["local", "Не удалось записать справочники на этом компьютере."],
    ["feed", "Ленту изменений хоста не удалось применить."],
  ])("explains a failed first sync by its class (%s), as the status line does", (failure, text) => {
    renderLineSelect({ ...syncState("failed", 0), failure });
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText("Не удалось получить справочники с хоста.")).toBeNull();
  });

  it("says when the host has no active lines", async () => {
```

5. Там же фрагмент

<!-- prettier-ignore -->
```tsx
  it("shows the link and opens the office", () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
  it("says a copy that cannot be read is this computer's, not the host's", async () => {
    const { props } = renderLineSelect(syncState("done", 1), { local: UNREADABLE });
    expect(
      await screen.findByText("Не удалось прочитать справочники на этом компьютере."),
    ).toBeTruthy();
    expect(screen.queryByText("Не удалось получить справочники с хоста.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("shows progress, not the older alert, while the retry syncs", async () => {
    const { props, view } = renderLineSelect(syncState("done", 1), { local: UNREADABLE });
    await screen.findByText("Не удалось прочитать справочники на этом компьютере.");
    view.rerender(<LineSelect {...props} sync={syncState("running", 1)} />);
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByText("Не удалось прочитать справочники на этом компьютере.")).toBeNull();
  });

  it("explains the latest failure: a sync that failed after the copy could not be read", async () => {
    const { props, view } = renderLineSelect(syncState("done", 1), { local: UNREADABLE });
    await screen.findByText("Не удалось прочитать справочники на этом компьютере.");
    view.rerender(<LineSelect {...props} sync={{ ...syncState("failed", 1), failure: "host" }} />);
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    expect(screen.queryByText("Не удалось прочитать справочники на этом компьютере.")).toBeNull();
  });

  it("shows the link and opens the office", () => {
```

6. В `apps/standalone/test/app.test.tsx`, в конце файла, фрагмент

<!-- prettier-ignore -->
```tsx
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reference sync health on screen", () => {
  it("shows a failed sync on the floor and in the office header until a sync succeeds", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    // Every sync fails, the retries too, until the host answers below.
    host.getChanges.mockRejectedValue(hostDown());
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    expect(
      await screen.findByText("Справочники не обновились — повторим автоматически"),
    ).toBeTruthy();
    expect(screen.getByText("Хост не ответил на запрос.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Справочники не обновились — повторим автоматически")).toBeTruthy();

    host.getChanges.mockResolvedValue(feedPage(43));
    await link.revision(43);
    await waitFor(() =>
      expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull(),
    );
  });

  it("shows how many feed records the copies did not accept", async () => {
    const host = fakeHost();
    const unreadable: ChangeItem = {
      entity: "lines",
      id: LINE_ID,
      rev: 42,
      deleted: false,
      data: { name: "Линия 1", archived: "да" },
    };
    host.getChanges.mockResolvedValueOnce(feedPage(42, [unreadable]));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    expect(await screen.findByText("Не приняты записи справочников: 1")).toBeTruthy();
    expect(screen.getByText("Цех")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/app.test.tsx`
Expected: FAIL — 12 тестов из 77, у всех «Unable to find an element with the text: …»:

- `host-status-line.test.tsx`, 5 тестов: три класса сбоя, повтор и число в карантине;
- `line-select.test.tsx`, 5 новых тестов: «Не удалось записать справочники на этом компьютере.», «Ленту изменений хоста не удалось применить.» (прежний экран на любой сбой говорит о хосте) и трижды «Не удалось прочитать справочники на этом компьютере.»;
- `app.test.tsx`, 2 теста «reference sync health on screen».

Тесты «без связи» и «тишина» проходят и до правки: они проверяют отсутствие текста.

- [ ] **Step 3: Строка связи, экраны, офис и тексты**

1. Заменить содержимое `apps/standalone/src/app/HostStatusLine.tsx` целиком:

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { StatusChip, type TagPhase } from "@markiro/ui";

import type { HostStatus } from "../host/protocol.js";
import type { SyncState } from "./shell.js";

const PHASE: Readonly<Record<HostStatus["state"], TagPhase>> = {
  online: "active",
  connecting: "running",
  offline: "attention",
};

/** Hours and minutes on this computer's clock. */
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
/** Day and month on this computer's clock, for a contact not made today. */
const DATE = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });

/** Whether two instants fall on the same day on this computer's calendar. */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export interface HostStatusLineProps {
  /** The link as the shell reports it; `null` before the first status. */
  status: HostStatus | null;
  /** The reference sync; `null` where the shell's sync is unknown, as in office tests. */
  sync: SyncState | null;
}

/**
 * The link to the host and the health of the local copies, on the floor,
 * on the line screen and in the office header: a tag that says it in words,
 * since when the host is silent and why the last attempt failed; while the
 * host answers, a failed sync the shell retries on its own, and why; and
 * how many feed records the copies did not accept. The live region itself
 * renders from the first paint, empty until the shell's first status, so a
 * screen reader already watches it and announces that first status too,
 * instead of only ones after it.
 */
export function HostStatusLine({ status, sync }: HostStatusLineProps) {
  const { t } = useTranslation();
  let link: ReactNode = null;
  if (status !== null) {
    let label = t("link.online");
    if (status.state === "connecting") label = t("link.connecting");
    if (status.state === "offline") {
      if (status.lastContactAt === null) {
        label = t("link.offline");
      } else {
        const contact = new Date(status.lastContactAt);
        // A contact from an earlier day reads as if it happened today
        // otherwise: name the day too, not just the hour and minute.
        label = sameLocalDay(contact, new Date())
          ? t("link.offlineSince", { time: CLOCK.format(contact) })
          : t("link.offlineSinceDate", {
              date: DATE.format(contact),
              time: CLOCK.format(contact),
            });
      }
    }
    link = (
      <span className="host-status__line">
        <StatusChip phase={PHASE[status.state]} label={label} />
        {status.state !== "online" && status.lastError !== null && (
          <span className="host-status__reason">{t(`errors.link.${status.lastError}`)}</span>
        )}
      </span>
    );
  }
  // Without the host the link's own words say why, and the retry waits for it.
  const failure = status?.state === "online" ? (sync?.failure ?? null) : null;
  const quarantined = sync?.quarantined ?? 0;
  return (
    <div className="host-status" role="status" aria-live="polite">
      {link}
      {failure !== null && (
        <span className="host-status__line">
          <StatusChip phase="attention" label={t("link.syncFailed")} wrap />
          <span className="host-status__reason">{t(`errors.sync.${failure}`)}</span>
        </span>
      )}
      {quarantined > 0 && (
        <span className="host-status__line">
          <StatusChip phase="attention" label={t("link.quarantined", { n: quarantined })} wrap />
        </span>
      )}
    </div>
  );
}
```

2. В `apps/standalone/src/app/shell.css` фрагмент

<!-- prettier-ignore -->
```css
.host-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
```

заменить на

<!-- prettier-ignore -->
```css
/* One line for the link, then one for each warning about the local copies. */
.host-status {
  display: grid;
  justify-items: start;
  gap: 8px;
}

.host-status__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
```

3. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "syncFailed": "Не удалось получить справочники с хоста.",
```

заменить на

<!-- prettier-ignore -->
```json
      "syncFailed": "Не удалось получить справочники с хоста.",
      "readFailed": "Не удалось прочитать справочники на этом компьютере.",
```

4. Там же фрагмент

<!-- prettier-ignore -->
```json
    "offlineSinceDate": "Нет связи с хостом с {{date}} {{time}}"
  },
```

заменить на

<!-- prettier-ignore -->
```json
    "offlineSinceDate": "Нет связи с хостом с {{date}} {{time}}",
    "syncFailed": "Справочники не обновились — повторим автоматически",
    "quarantined": "Не приняты записи справочников: {{n}}"
  },
```

5. Там же фрагмент

<!-- prettier-ignore -->
```json
      "stream_ended": "Связь с хостом прервалась."
    },
```

заменить на

<!-- prettier-ignore -->
```json
      "stream_ended": "Связь с хостом прервалась."
    },
    "sync": {
      "host": "Хост не ответил на запрос.",
      "local": "Не удалось записать справочники на этом компьютере.",
      "feed": "Ленту изменений хоста не удалось применить."
    },
```

6. В `apps/standalone/src/app/screens.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { RejectionReason } from "./shell.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { RejectionReason, SyncState } from "./shell.js";
```

7. Там же фрагмент

<!-- prettier-ignore -->
```tsx
/** The floor placeholder until plan 1f: the link to the host and the way into the office. */
export function FloorScreen({ link, onOffice }: { link: HostStatus | null; onOffice: () => void }) {
```

заменить на

<!-- prettier-ignore -->
```tsx
/**
 * The floor placeholder until plan 1f: the link to the host, the health of
 * the local copies and the way into the office.
 */
export function FloorScreen({
  link,
  sync,
  onOffice,
}: {
  link: HostStatus | null;
  sync: SyncState;
  onOffice: () => void;
}) {
```

8. Там же фрагмент

<!-- prettier-ignore -->
```tsx
        <p>{t("floor.body")}</p>
        <HostStatusLine status={link} />
```

заменить на

<!-- prettier-ignore -->
```tsx
        <p>{t("floor.body")}</p>
        <HostStatusLine status={link} sync={sync} />
```

9. В `apps/standalone/src/app/LineSelect.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { SyncState } from "./shell.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { SyncFailure, SyncState } from "./shell.js";
```

10. Там же фрагмент

<!-- prettier-ignore -->
```tsx
/** «Линия 2» before «Линия 10». */
```

заменить на

<!-- prettier-ignore -->
```tsx
/**
 * The alert for a failed sync, by its class: the host's own wording, or the
 * status line's reason when this computer or the host's feed is to blame.
 */
const SYNC_FAILED_KEY = {
  host: "shell.lineSelect.syncFailed",
  local: "errors.sync.local",
  feed: "errors.sync.feed",
} as const satisfies Record<SyncFailure, string>;

/** «Линия 2» before «Линия 10». */
```

11. Там же фрагмент

<!-- prettier-ignore -->
```tsx
/**
 * A paired station chooses its line (spec §5.1) among the active lines of
 * the local copies. They are read only once a sync in this session brought
 * them up to date, and again after every sync, so a previous pairing's lines
 * never show.
 */
```

заменить на

<!-- prettier-ignore -->
```tsx
/**
 * A paired station chooses its line (spec §5.1) among the active lines of
 * the local copies. They are read only once a sync in this session brought
 * them up to date, and again after every sync, so a previous pairing's lines
 * never show. A failed sync is explained by its class, in the status line's
 * words; a copy that cannot be read is this computer's failure, not the
 * host's, and the screen says so.
 */
```

12. Там же фрагмент

<!-- prettier-ignore -->
```tsx
    if (lines === null) {
      if (sync.kind === "failed" || readFailed) {
```

заменить на

<!-- prettier-ignore -->
```tsx
    if (lines === null) {
      // The latest failure: a sync failed after the last read, or the read
      // failed after the last sync. A sync in progress, the retry's too,
      // shows progress instead of an older failure.
      if (sync.kind === "failed" || (readFailed && sync.kind !== "running")) {
```

13. Там же фрагмент

<!-- prettier-ignore -->
```tsx
            {t("shell.lineSelect.syncFailed")}
```

заменить на

<!-- prettier-ignore -->
```tsx
            {t(
              sync.kind === "failed"
                ? SYNC_FAILED_KEY[sync.failure ?? "host"]
                : "shell.lineSelect.readFailed",
            )}
```

14. Там же фрагмент

<!-- prettier-ignore -->
```tsx
        <HostStatusLine status={link} />
```

заменить на

<!-- prettier-ignore -->
```tsx
        <HostStatusLine status={link} sync={sync} />
```

15. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        link={state.link}
        local={localDb}
```

заменить на

<!-- prettier-ignore -->
```tsx
        link={state.link}
        sync={state.sync}
        local={localDb}
```

16. Там же фрагмент

<!-- prettier-ignore -->
```tsx
      {view.kind === "floor" && (
        <FloorScreen link={state.link} onOffice={() => dispatch({ type: "office_requested" })} />
      )}
```

заменить на

<!-- prettier-ignore -->
```tsx
      {view.kind === "floor" && (
        <FloorScreen
          link={state.link}
          sync={state.sync}
          onOffice={() => dispatch({ type: "office_requested" })}
        />
      )}
```

17. Заменить содержимое `apps/standalone/src/office/office-link.tsx` целиком:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";

/** The link to the host and the reference sync as the shell reports them, for the office header. */
export interface OfficeLink {
  /** `null` before the shell's first status and outside the app. */
  status: HostStatus | null;
  /** `null` outside the app. */
  sync: SyncState | null;
}

const OfficeLinkContext = createContext<OfficeLink>({ status: null, sync: null });

export function OfficeLinkProvider({
  value,
  children,
}: {
  value: OfficeLink;
  children: ReactNode;
}) {
  return <OfficeLinkContext.Provider value={value}>{children}</OfficeLinkContext.Provider>;
}

export function useOfficeLink(): OfficeLink {
  return useContext(OfficeLinkContext);
}
```

18. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { useEffect, useRef, useState } from "react";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
```

19. Там же фрагмент

<!-- prettier-ignore -->
```tsx
import type { HostStatus } from "../host/protocol.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
```

20. Там же фрагмент

<!-- prettier-ignore -->
```tsx
  /** The link to the host, shown in the header; `null` before the first status. */
  link?: HostStatus | null;
```

заменить на

<!-- prettier-ignore -->
```tsx
  /** The link to the host, shown in the header; `null` before the first status. */
  link?: HostStatus | null;
  /** The reference sync, shown in the header with the link; `null` outside the app. */
  sync?: SyncState | null;
```

21. Там же фрагмент

<!-- prettier-ignore -->
```tsx
export function Office({ session, link = null, local = null, hostRevision = null }: OfficeProps) {
```

заменить на

<!-- prettier-ignore -->
```tsx
export function Office({
  session,
  link = null,
  sync = null,
  local = null,
  hostRevision = null,
}: OfficeProps) {
```

22. Там же фрагмент

<!-- prettier-ignore -->
```tsx
  }, [hostRevision, session]);
  return (
```

заменить на

<!-- prettier-ignore -->
```tsx
  }, [hostRevision, session]);
  const officeLink = useMemo(() => ({ status: link, sync }), [link, sync]);
  return (
```

23. Там же фрагмент

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={link}>
```

заменить на

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={officeLink}>
```

24. В `apps/standalone/src/office/OfficeShell.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          <HostStatusLine status={link} />
```

заменить на

<!-- prettier-ignore -->
```tsx
          <HostStatusLine status={link.status} sync={link.sync} />
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/app.test.tsx`
Expected: PASS — 15 тестов в `host-status-line.test.tsx`, 14 в `line-select.test.tsx`, 48 в `app.test.tsx` (77).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в разделе «App shell», фрагмент

<!-- prettier-ignore -->
```text
`HostStatusLine` shows the link on the floor, on the line screen and in the
office header — online, connecting, or silent since the last contact, with the
reason — as a phase tag with words in a polite live region. There is no
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.
```

заменить на

<!-- prettier-ignore -->
```text
`HostStatusLine` shows the link on the floor, on the line screen and in the
office header — online, connecting, or silent since the last contact, with the
reason — as a phase tag with words in a polite live region. In the same region
it warns, while the link is online, that the copies did not update and will be
retried, with the failure's reason (`errors.sync.<failure>`), and at any link
state how many feed records the copies did not accept (`quarantined`); the
office header reads the sync state next to the link (`OfficeLinkProvider`).
The line screen's alert names a failed sync by its class in the same words
(its own host wording for `host`, `errors.sync.local` and `errors.sync.feed`
otherwise) and a copy it cannot read as this computer's failure. There is no
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.1, фрагмент

<!-- prettier-ignore -->
```text
блокирующего слоя нет. Цех работает, строка связи есть и там.
```

заменить на

<!-- prettier-ignore -->
```text
блокирующего слоя нет. Цех работает, строка связи есть и там. Строка связи
показывает и здоровье справочников: пока хост на связи — что справочники не
обновились и прогон повторится сам, с причиной (хост не ответил, не удалось
записать на этом компьютере, ленту хоста не удалось применить), а при любой связи —
сколько записей ленты не принято (карантин, §5.4).
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые TS, TSX, CSS, JSON и MD; `git diff --check`
Expected: всё зелёное; Vitest — 29 файлов, 513 тестов.

```bash
git add apps/standalone/src/app/HostStatusLine.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/app/LineSelect.tsx apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/src/office/Office.tsx apps/standalone/src/office/office-link.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/test/host-status-line.test.tsx apps/standalone/test/line-select.test.tsx apps/standalone/test/app.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): сбой синхронизации и карантин видны в цехе, на выборе линии и в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Сброс подключения очищает локальные копии — `src-tauri`

С плана 1d3 в локальной базе лягут хеши PIN и бейджей. Сброс подключения — «Подключить заново» на экранах отказа и другого хоста, «Сбросить подключение» при повреждённом `device.json` — не должен их оставлять. `device_forget` сначала очищает все таблицы копий, потом удаляет `device.json`. Если очистка не удалась, `device.json` остаётся, и пользователь может повторить. Если локальная база не открылась, очищать нечего, и сброс идёт дальше: иначе сломанная база навсегда заперла бы экран сброса.

Список таблиц читается из `sqlite_master`, поэтому таблицы следующих миграций очищаются без правки. Внешние ключи проверяются при фиксации (`PRAGMA defer_foreign_keys = ON`): когда `operator_badges` будет ссылаться на `operators`, порядок удаления не важен. Тест создаёт такую пару таблиц сам и проверяет, что без отложенной проверки очистка упала бы.

Контракт IPC не меняется: команда получает `tauri::State<LocalDbState>`, а у вебвью по-прежнему нет аргументов и ответ — `null`. Состояние локальной базы уже зарегистрировано в `run()` и в тестовом `mock_app_with`.

**Files:**

- Modify: `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Modify: `apps/standalone/src-tauri/tests/local_db.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.2)

**Interfaces:**

- Consumes:
  - таблица `sync_quarantine` (задача 1);
  - `LocalDbState::get(&self) -> Result<&LocalDb, LocalDbError>`, `LocalDbError::StatementFailed` — `src-tauri/src/local_db.rs`;
  - `DeviceState::forget(&self) -> Result<(), DeviceError>`, `DeviceError::Storage` (код `storage`) — `src-tauri/src/device.rs`;
  - `mock_app_with`, `invoke` — `src-tauri/tests/ipc.rs`; `open`, `statement`, `INSERT_LINE`, `LINE_1`, `LINE_2` — `src-tauri/tests/local_db.rs`.
- Produces:
  - `pub async fn clear_copies(&self) -> Result<(), LocalDbError>` у `LocalDb`;
  - `device_forget(state: tauri::State<'_, DeviceState>, local: tauri::State<'_, LocalDbState>) -> Result<(), String>`: сначала `clear_copies`, неудача — `"storage"`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/src-tauri/tests/local_db.rs`, в конце файла, фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(
        Value::Object(summary[0].clone()),
        json!({ "lines": 1000, "rev": 7 })
    );
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(
        Value::Object(summary[0].clone()),
        json!({ "lines": 1000, "rev": 7 })
    );
}

/// Forgetting the device (`device_forget`) clears every table but sqlx's
/// migration journal: tables a later migration adds too, since the list
/// comes from `sqlite_master`, and in any order despite foreign keys.
#[tokio::test]
async fn clearing_the_copies_empties_every_table_but_the_migration_journal() {
    let (dir, db) = open().await;
    db.transaction(vec![
        statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 3])),
        statement(
            "INSERT INTO sync_state (key, value) VALUES ('last_rev', '3')",
            json!([]),
        ),
        statement(
            "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) \
             VALUES ('lines', ?, 4, 'archived: invalid_type', 1790000000000)",
            json!([LINE_2]),
        ),
    ])
    .await
    .unwrap();
    // Tables as a later migration might add them, the second referring to
    // the first; the webview may not create tables, so a raw connection
    // does. `extra_holder` sorts first, so its delete runs while
    // `extra_item` still refers to it.
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    for sql in [
        "CREATE TABLE extra_holder (id TEXT PRIMARY KEY)",
        "CREATE TABLE extra_item (id TEXT PRIMARY KEY, \
         holder_id TEXT NOT NULL REFERENCES extra_holder (id))",
        "INSERT INTO extra_holder (id) VALUES ('h')",
        "INSERT INTO extra_item (id, holder_id) VALUES ('i', 'h')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();
    let journal = "SELECT count(*) AS n FROM _sqlx_migrations";
    let migrations = db.query(journal, vec![]).await.unwrap();

    assert_eq!(db.clear_copies().await, Ok(()));

    let left = db
        .query(
            "SELECT (SELECT count(*) FROM ref_org) + (SELECT count(*) FROM ref_site) \
             + (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) \
             + (SELECT count(*) FROM sync_quarantine) + (SELECT count(*) FROM extra_holder) \
             + (SELECT count(*) FROM extra_item) AS n",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(Value::Object(left[0].clone()), json!({ "n": 0 }));
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
    // The database takes writes afterwards as before.
    assert_eq!(
        db.transaction(vec![statement(
            INSERT_LINE,
            json!([LINE_1, "Линия 1", 0, 5])
        )])
        .await,
        Ok(vec![1])
    );
}
```

2. В `apps/standalone/src-tauri/tests/ipc.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::local_db::LocalDbState;
use serde_json::{json, Value};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::local_db::{LocalDbState, FILE_NAME};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn without_a_local_database_the_local_commands_say_so() {
```

заменить на

<!-- prettier-ignore -->
```rust
/// Statements a later migration might run, on the app's database behind
/// the webview's back: the webview may not create tables or triggers.
fn run_raw(dir: &std::path::Path, statements: &[&str]) {
    tauri::async_runtime::block_on(async {
        let mut raw = SqliteConnectOptions::new()
            .filename(dir.join(FILE_NAME))
            .connect()
            .await
            .unwrap();
        for sql in statements {
            sqlx::query(sql).execute(&mut raw).await.unwrap();
        }
        raw.close().await.unwrap();
    });
}

/// `device_forget` clears the local copies before it removes `device.json`:
/// when clearing fails, the command answers `storage` and the pairing stays,
/// so the user can try again.
#[test]
fn forgetting_the_device_clears_the_local_copies_first() {
    const LINE: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    let app_dir = tempfile::tempdir().unwrap();
    // A pairing the app cannot read: the config-error screen offers exactly
    // this reset, and no host has to answer.
    let config = app_dir.path().join("device.json");
    std::fs::write(&config, "{").unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    invoke(
        &webview,
        "local_transaction",
        json!({ "statements": [
            {
                "sql": "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)",
                "values": [LINE, "Линия 1", 0, 1]
            },
            { "sql": "INSERT INTO sync_state (key, value) VALUES ('last_rev', '1')" }
        ] }),
    )
    .unwrap();
    // A table whose rows refuse to go.
    run_raw(
        app_dir.path(),
        &[
            "CREATE TABLE extra_kept (id TEXT PRIMARY KEY)",
            "CREATE TRIGGER extra_kept_stays BEFORE DELETE ON extra_kept \
             BEGIN SELECT RAISE(ABORT, 'kept'); END",
            "INSERT INTO extra_kept (id) VALUES ('k')",
        ],
    );
    let copies = || {
        invoke(
            &webview,
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) \
                        + (SELECT count(*) FROM extra_kept) AS n",
                "params": []
            }),
        )
        .unwrap()
    };

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("storage"))
    );
    assert!(config.exists(), "the pairing stays for another try");
    assert_eq!(
        copies(),
        json!([{ "n": 3 }]),
        "the clearing rolled back whole"
    );

    run_raw(app_dir.path(), &["DROP TRIGGER extra_kept_stays"]);
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert_eq!(copies(), json!([{ "n": 0 }]));
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );
}

#[test]
fn without_a_local_database_the_local_commands_say_so() {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`, затем `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies`
Expected: FAIL — не компилируется: ``error[E0599]: no method named `clear_copies` found for struct `LocalDb` in the current scope``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device`
Expected: FAIL — `forgetting_the_device_clears_the_local_copies_first`: `left: Ok(Null)`, `right: Err(String("storage"))` — сброс прошёл, ничего не очистив.

- [ ] **Step 3: `LocalDb::clear_copies` и `device_forget`**

1. В `apps/standalone/src-tauri/src/local_db.rs`, в конце `impl LocalDb`, фрагмент

<!-- prettier-ignore -->
```rust
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        Ok(changes)
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        Ok(changes)
    }

    /// Delete every row of every table but sqlx's migration journal, in one
    /// writer transaction: forgetting the device must not leave another
    /// pairing's copies behind (from plan 1d3 on, PIN and badge hashes).
    /// The tables come from `sqlite_master`, so one a later migration adds is
    /// covered without a change here. Foreign keys are checked at the commit,
    /// when every table is empty, so the order of the deletes does not matter.
    pub async fn clear_copies(&self) -> Result<(), LocalDbError> {
        let mut tx = self
            .writer
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        sqlx::query("PRAGMA defer_foreign_keys = ON")
            .execute(&mut *tx)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' \
             AND name <> '_sqlx_migrations' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| LocalDbError::StatementFailed)?;
        for table in tables {
            let delete = format!("DELETE FROM \"{}\"", table.replace('"', "\"\""));
            sqlx::query(&delete)
                .execute(&mut *tx)
                .await
                .map_err(|_| LocalDbError::StatementFailed)?;
        }
        tx.commit().await.map_err(|_| LocalDbError::StatementFailed)
    }
}
```

2. В `apps/standalone/src-tauri/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
use device::{DeviceState, DeviceStatus};
```

заменить на

<!-- prettier-ignore -->
```rust
use device::{DeviceError, DeviceState, DeviceStatus};
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[tauri::command]
async fn device_forget(state: tauri::State<'_, DeviceState>) -> Result<(), String> {
    state
        .forget()
        .await
        .map_err(|error| error.code().to_owned())
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// Forget the pairing: the local copies go first, so when clearing them
/// fails the command answers `storage` and `device.json` stays for another
/// try. Without a local database (it did not open) there is nothing this
/// app can clear, and forgetting goes on: the reset must stay possible.
#[tauri::command]
async fn device_forget(
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
) -> Result<(), String> {
    if let Ok(db) = local.get() {
        db.clear_copies()
            .await
            .map_err(|_| DeviceError::Storage.code().to_owned())?;
    }
    state
        .forget()
        .await
        .map_err(|error| error.code().to_owned())
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies`
Expected: PASS — 1 тест (8 отфильтрованы).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device`
Expected: PASS — 1 тест (7 отфильтрованы).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, в конце раздела «Local database», фрагмент

<!-- prettier-ignore -->
```text
That file also mirrors `local_db.rs`'s statement rules and limits; a rule
change there means updating `test/support/local-db.ts` too and adding a case
to `src-tauri/tests/fixtures/local-sql.json`.
```

заменить на

<!-- prettier-ignore -->
```text
That file also mirrors `local_db.rs`'s statement rules and limits; a rule
change there means updating `test/support/local-db.ts` too and adding a case
to `src-tauri/tests/fixtures/local-sql.json`.

`device_forget` clears the local copies before it removes `device.json`:
`LocalDb::clear_copies` deletes every row of every table but
`_sqlx_migrations`, in one writer transaction with foreign keys checked at
the commit. The tables come from `sqlite_master`, so one a later migration
adds is covered, PIN and badge hashes included. If clearing fails, the
command fails with `storage` and the pairing stays for another try; without
a local database (it did not open) there is nothing to clear, and
forgetting goes on.
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.2, фрагмент

<!-- prettier-ignore -->
```text
  `device.json`), `device_forget()`. Таймауты: соединение 2 с,
```

заменить на

<!-- prettier-ignore -->
```text
  `device.json`), `device_forget()` (сначала очищает локальную базу — все таблицы,
  кроме журнала миграций; если очистка не удалась, подключение остаётся). Таймауты:
  соединение 2 с,
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые MD; `git diff --check`
Expected: чисто.

Run: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`, затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
Expected: PASS — 30 наборов, 224 теста (222 после плана 1c3 и два новых), без предупреждений компилятора.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 29 файлов, 513 тестов (TypeScript задача не меняет).

```bash
git add apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): сброс подключения очищает локальные копии" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build` — зелёные; Vitest — 29 файлов, 513 тестов; один прогон с `--reporter=verbose` — stderr пуст, предупреждений `act(...)` нет.
- [ ] `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'` (крейт оболочки встраивает `apps/standalone/dist`), затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — 30 наборов, 224 теста, без предупреждений компилятора.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам — чисто; `git diff --check <начало плана>..HEAD` — чисто.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `apps/station`, `tools/ci/affected.mjs` и код хоста (`apps/standalone/host`) не менялись.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - окно `tauri dev`: строка связи с предупреждениями в цехе, на выборе линии и в шапке офиса при ширине 1024–1280, тёмная и светлая темы, чтение живой области экранным диктором;
  - настоящий хост с повреждённой или более новой записью ленты: тесты подставляют ленту, реальный хост таких записей сейчас не отдаёт;
  - повтор на живой связи: выдернутый кабель (`offline` снимает повтор), возврат связи (прогон сразу), хост, который отвечает ошибкой, — вручную на двух ПК;
  - `device_forget` на Windows: DPAPI и файл базы, занятый другим процессом;
  - задание CI `standalone-windows-build` — для него нужен push.

---

## Отклонения при исполнении

Записано по итогам исполнения 2026-09-27. Там, где задачи выше расходятся с кодом в ветке, верен этот раздел.

**Карантин (задача 1 и ревью)**

- Задача вошла как написана.
- Граница снятия карантина — «не меньше» и для читаемой записи, и для надгробия. Её закрепляет тест с равной ревизией (итоговое ревью).
- `tables()` в тестах синхронизации включает `sync_quarantine`. Откат хоста очищает карантин с первой новой порцией и сохраняет его, если повторная загрузка не удалась.
- Два теста помечены как «только при повторе»: при обычной ленте хост не присылает старую ревизию записи после новой.

**Класс сбоя и повтор (задача 2 и ревью)**

- Добавлены тесты:
  - сброс счёта после удачного прогона;
  - прогон, упавший без связи, повтор не ставит, а связь `online` запускает один прогон сразу.
- Тест повтора с экрана выбора линии переведён на поддельные таймеры, потому что он гонялся с настоящим двухсекундным повтором. Он же проверяет, что запрос снимает ожидающий повтор: следующий повтор идёт через 4 с.
- Класс `host` описан точнее: хост недоступен либо отказал в запросе или не выполнил его.

**Сбой на экранах (задача 3 и ревью)**

- `errors.sync.host` — «Запрос к хосту не удался.» вместо «Хост не ответил на запрос.»: ответ хоста с ошибкой (500) — тоже класс `host`.
- Новые тесты приложения стоят в конце `test/app.test.tsx`: якорь плана сдвинула правка задачи 2.

**Сброс подключения (задача 4 и ревью)**

- Список таблиц `clear_copies` берётся из `pragma_table_list` (`type IN ('table', 'virtual')`), а не из `sqlite_master`. Теневые таблицы виртуальной таблицы (FTS5, RTree) прямой `DELETE` испортил бы. Это закреплено тестом с FTS5.
- Таблица, которая отказывает в очистке в тесте IPC, называется `zz_kept`: она очищается последней, иначе проверка отката ничего не доказывала.
- Отдельный тест в песочнице закрепляет правило: сброс без открытой локальной базы проходит.
- В заголовках миграций 0001 и 0002 исправлена фраза «единственный писатель — синхронизация». sqlx хранит контрольную сумму файла миграции, поэтому так можно только до первого выпуска. Станционных баз старше d85df47 нет: окно `tauri dev` не запускали.

**Итоговое ревью (03a838a, ce367f3)**

- Число записей в карантине читается и после неудачного прогона: `readQuarantineCount` и `sync_failed.quarantined: number | null`, где `null` сохраняет прежнее число. После перезапуска без хоста станция и офис показывают, сколько записей не принято, как решил владелец.
- Проверка хоста в начале порции требует записанную строку: `value = ?` с `expectedChanges: 1`. Порция, полученная до сброса и применённая после `clear_copies`, отклоняется и не восстанавливает копии прежнего подключения. Ветка синхронизации с нуля требует совпадения записанного `host_id`.
- Экран выбора линии:
  - ошибка чтения своей копии привязана к синхронизации, после которой случилась, и после удачного прогона не всплывает снова;
  - пока линий нет, строка связи не повторяет сбой, о котором говорит сам экран;
  - если записи в карантине, пустой список объяснён этим.
- `clear_copies` считает каждую таблицу одноразовой копией данных хоста. Это записано в `AGENTS.md`, а тест закрепляет список таблиц. Первый план с собственными данными станции обязан исключить их из очистки и не давать сбросить подключение с неотправленными записями.
- Спецификация §5.1 названа по-новому: «запрос к хосту не удался».
- Удачный прогон считает карантин функцией, которая при сбое чтения бросает ошибку (`countQuarantined`): прогон падает, а не сообщает ложный ноль. Функция, возвращающая `null` (`readQuarantineCount`), осталась для пути сбоя.
- Проверка хоста закреплена и для состояния без записанного `host_id`: синхронизация с нуля проходит один раз, а не зацикливается на `changes_mismatch`.

**Перенесено**

- План 1d2 (договор ленты для операторов и бейджей):
  - изменение, закрывающее доступ (отзыв бейджа, выключение оператора), идёт по ленте надгробием, а не флагом: вебвью читает записи через `z.object`, и незнакомое поле просто отбросилось бы;
  - и/или схемы `operators`, `operator_badges` и `site` — `z.strictObject` с подъёмом `SYNC_SCHEMA_VERSION`;
  - политика `minProtocol`: отвергнутое старое приложение офлайн живёт на своих копиях.
- План 1d3:
  - `secure_delete` у писателя и `wal_checkpoint(TRUNCATE)` или `VACUUM` после очистки: удалённые хеши остаются в свободных страницах и WAL;
  - сброс, когда база не открылась;
  - фраза в `AGENTS.md` о том, что `reason` безопасен только при схемах с фиксированными ключами;
  - `AND NOT EXISTS` по карантину в upsert операторов и бейджей;
  - предел бюджета E = 8 (30 из 32) для плана 1e.
- План 1d4: предупреждение объявляется заново при каждом автоматическом повторе; `protocol_unsupported` повторяется бесконечно с общим текстом (также план 5).
- План 5:
  - последняя ошибка (класс, код, сообщение без значений) для диагностики;
  - политика отката на старую сборку (`VersionMissing`) и тест, закрепляющий контрольные суммы миграций, — до первого выпуска.

**Проверено**

- На ce367f3:
  - Vitest — 29 файлов, 531 тест; с `--reporter=verbose` в stderr пусто;
  - `typecheck`, `lint`, `build`;
  - `cargo test --workspace` — 30 наборов, 226 тестов, без предупреждений (вне песочницы); `cargo fmt --check`;
  - `git diff --check` по всему плану (119f654..ce367f3).
- Итоговое ревью проверило исправления мутациями: 22 прогона и проверка счётчиков изменений SQLite.

**Не проверено**

- Окно `tauri dev`: строка связи с 0–2 предупреждениями в шапке офиса при ширине 1024–1280, светлая и тёмная темы.
- Объявления экранного диктора (NVDA): сбой объявляется один раз, повторы и переподключение.
- Два ПК в сети:
  - кабель выдернут — запросов к хосту нет;
  - кабель вставлен — синхронизация сразу;
  - хост отвечает 500 — повторы через 2/4/8/16/32/60 с.
- Перезапуск станции с выключенным хостом и непустым карантином.
- Нечитаемая запись с хоста (сборка с внесением сбоев).
- `device_forget` на Windows: база заблокирована другим процессом → `storage`; база не открывается → сброс проходит.
- Задание `standalone-windows-build` — для CI нужен push.
