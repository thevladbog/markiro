# План 1c3: вебвью второго устройства — синхронизация справочников, подключение по коду, выбор линии, строка связи и «Устройства» в офисе — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Второе устройство подключается к хосту одноразовым кодом из офиса — сканером машиночитаемого кода или вводом адреса и кода со сверкой отпечатка — и получает справочники. Вебвью держит локальные копии в ногу с лентой изменений хоста, станция без линии выбирает её, строка состояния показывает связь с хостом. Офис получает страницу «Устройства» с диалогом кода подключения и по каждой новой ревизии хоста перечитывает вошедшего пользователя. Так закрывается строка «1c» раздела 8 спецификации: «Второе устройство подключается и получает справочники».

**Architecture:**

- `src/local/reference-sync.ts` — синхронизация справочников:
  - порции `GET /v1/changes` (`HostApi.getChanges`), каждая одной `local_transaction`;
  - условные удаления по надгробиям и upsert через `json_each`;
  - планировщик, который пускает один прогон за раз.
- `src/host/pairing-code.ts` — вид кода подключения (`normalizePairingCode`, то же правило, что `markiro_proto::pairing::normalize`, закреплено общей фикстурой) и разбор машиночитаемого кода, в том числе набранного клавиатурным сканером при русской раскладке.
- Оболочка:
  - `src/app/shell.ts` получает связь с хостом, состояние синхронизации и последнюю ревизию хоста;
  - `src/app/host-link.ts` (`useHostLink`) держит одну подписку на связь и один планировщик, пока устройство подключено;
  - новые экраны: другой хост, выбор линии (`LineSelect`), подключение к хосту в сети (`NetworkPairing`);
  - строка связи (`HostStatusLine`) — в цехе, на выборе линии и в шапке офиса.
- Офис:
  - страница «Устройства» для администратора: список устройств и диалог кода подключения (DataMatrix, код, отпечаток, адреса хоста, таймер);
  - по новой ревизии хоста перечитывается вошедший пользователь (имя и роль); открытая страница под ним не перезагружается.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, @tanstack/react-query 5.101.4, react-router 8.3 в режиме памяти, i18next, `@markiro/ui`, `@markiro/domain` (`renderLiteralDataMatrixSvg`), Vitest 4 с jsdom и `node:sqlite`. Rust — только тест фикстуры в `proto`.

**Спецификации:**

- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`:
  - §4.7 — подключение устройств;
  - §5.1 — оболочка;
  - §5.4 — синхронизация справочников;
  - §5.5 — офис;
  - §7 — тестирование;
  - §8, строка 1c.
- Решения контроллера — `.superpowers/sdd/1c3-design.md`, обоснования — `.superpowers/sdd/1c3-notes.md`.
- API хоста — план 1c1 (`docs/superpowers/plans/2026-09-27-standalone-1c1-host-pairing-feed.md`) и его раздел «Отклонения при исполнении»:
  - события потока строго растут;
  - `hasMore` — только когда за порцией есть записи;
  - формат кода — `markiro_proto::pairing`.
- Привязки вебвью — план 1c2 (`docs/superpowers/plans/2026-09-27-standalone-1c2-app-shell-sync.md`), задача 5. Их имена и сигнатуры — контракт этого плана.

## Global Constraints

**Зависимости**

- Новых зависимостей нет — ни JS, ни Rust. `renderLiteralDataMatrixSvg` уже есть в `@markiro/domain`, от которого зависит `@markiro/standalone`.
- Кодировщик DataMatrix (bwip-js) большой: компонент с ним загружается лениво (`React.lazy`), как `PairingBarcode` в админке.
- Импортов между приложениями нет: образцы из `apps/admin` переносятся копией.

**Контракт плана 1c2 (задача 5)**

- `DeviceApi.claim(input: ClaimInput): Promise<DeviceStatus>`, где `ClaimInput { address, fingerprint, code, name }`; `DeviceApi.selectLine(lineId: string): Promise<DeviceStatus>`.
- Коды отказов `pairing_code_invalid`, `pairing_code_expired`, `rate_limited`, `line_rejected`, `key_rejected`, `request_failed` с текстами `errors.device.*`.
- `createTauriConnectionApi(): ConnectionApi`, `watch(handlers: ConnectionHandlers): Promise<() => void>`, `ConnectionHandlers { onStatus: (status: HostStatus) => void; onRevision: (rev: number) => void }` (свойства-функции).
- `HostStatus`:
  - `state`: `online`, `connecting` или `offline`;
  - `lastContactAt`: миллисекунды Unix или `null`;
  - `lastError`: `unreachable`, `certificate_mismatch`, `key_rejected`, `stream_refused`, `stream_ended` или `null`;
  - `seq`: порядковый номер.
- `LocalExecutor { query<T>(sql, params, row: z.ZodType<T>): Promise<T[]>; transaction(statements: readonly LocalStatement[]): Promise<number[]> }`, `createTauriLocalExecutor()`. В тестах — `openLocalDb(): { db: DatabaseSync; executor: LocalExecutor }` (`test/support/local-db.ts`) на `node:sqlite` с миграциями оболочки.
- Таблицы `ref_org(id, name, inn, gln, gs1_prefixes, time_zone, rev)`, `ref_site(id, badge_salt, box_block_size, pallet_block_size, rev)`, `ref_lines(id, name, archived, rev)`, `sync_state(key, value)`. `host_request` пропускает `GET /v1/changes`.

**Синхронизация справочников**

- `ENTITY_SET = "org_profile,site,lines"`. Ключи `sync_state`: `last_rev` (десятичная строка), `host_id`, `entity_set`.
- Лента — `GET /v1/changes?since=<rev>` (`HostApi.getChanges`) только с ключом устройства, без офисной сессии, порциями до `hasMore = false`.
- Порция — одна `local_transaction`:
  - на сущность одно условное удаление по надгробиям: строка удаляется, только если ревизия надгробия больше её ревизии;
  - на сущность один upsert через `json_each(?)` с `ON CONFLICT (id) DO UPDATE … WHERE excluded.rev > ref_x.rev`;
  - в конце — запись `sync_state`;
  - первым оператором порции — проверка, что `sync_state.host_id` не сменился (`UPDATE … WHERE key = 'host_id' AND value <> ?` с `expectedChanges: 0`): поздняя порция прежнего хоста после переподключения откатывается; перед первой синхронизацией и при очистке для другого хоста `host_id` записывается сразу (исполнение задачи 1);
  - вместе с проверкой и очисткой — не больше 12 операторов, в пределах 32 у оболочки.
- Каждая живая запись проверяется своей схемой (`orgRecordSchema`, `siteRecordSchema`, `lineRecordSchema`) до записи: плохая запись — ошибка, порция не применяется. Неизвестные сущности пропускаются.
- Синхронизация с нуля:
  - `host_id` другого хоста — очистка сразу, отдельной транзакцией;
  - `entity_set` не равен `ENTITY_SET` или нет `last_rev` — очистка в транзакции первой новой порции;
  - ответ `rev < since` (хост откатился) — так же, не больше одного раза за прогон; второй откат — ошибка.
- `hostId` ленты не равен подключённому — результат `other_host`, ничего не применяется.
- Планировщик: один прогон за раз; запуски во время прогона дают ровно один следующий прогон; неудачный прогон ждёт следующего запуска.

**Код подключения и машиночитаемый код**

- `normalizePairingCode` повторяет `markiro_proto::pairing::normalize`:
  - пропускаются символы Unicode White_Space, ASCII-дефис, U+2010–U+2015 и U+2212;
  - в верхний регистр переводятся только ASCII-буквы;
  - O читается как 0, I и L — как 1;
  - результат — ровно 10 символов из `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, иначе `null`.
- Общая фикстура `proto/fixtures/pairing-codes.json` проверяется и в Rust, и в Vitest.
- Машиночитаемый код `markiro-host:1?h=<a,b>&p=<порт>&f=<отпечаток>&c=<код>`:
  - адреса — IPv4; пустой `h=` допустим и даёт `addresses: []`;
  - порт — 1–65535;
  - отпечаток — 64 hex-символа, приводится к нижнему регистру;
  - код — через `normalizePairingCode`;
  - схема и имена полей — без учёта регистра (Caps Lock);
  - повтор поля или поле без `=` — отказ;
  - ведущий идентификатор AIM `]d` или `]D` (Caps Lock) с цифрой отбрасывается;
  - адреса — десятичные октеты без ведущих нулей (как `Ipv4Addr` в Rust);
  - текст с кириллицей, который не разобрался, пробуется ещё раз с обращённым регистром кириллицы: так читается скан при русской раскладке с Caps Lock (двоеточие схемы даёт только клавиша `Ж`, поэтому вариант однозначен). Исполнение задачи 2, ревью проверило 80 000 смоделированных сканов.
- Текст с кириллицей сначала переводится из раскладки ЙЦУКЕН в позиции клавиш US. Цифры, `-`, `=` и пробел не меняются. Таблица:

```text
русская раскладка:  йцукенгшщзхъфывапролджэячсмитьбюё ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁ . , " № ; : ? /
те же клавиши в US: qwertyuiop[]asdfghjkl;'zxcvbnm,.` QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>~ / ? @ # $ ^ & |
```

**Экраны оболочки**

- Порядок `nextShellView`:
  1. загрузка и повреждённая конфигурация;
  2. неподключённое устройство: подключение в сети, если его выбрали, иначе по местному хосту;
  3. отказ хоста (`rejection`);
  4. другой хост;
  5. версия и личность местного хоста;
  6. офис и вход в офис;
  7. выбор линии (станция без линии);
  8. цех.
- `lastError` связи `key_rejected` — отказ `key_rejected`, `certificate_mismatch` — отказ `host_changed`. Офис при этом закрывается, как при таком же ответе на запрос офиса.
- Связь и синхронизация идут, пока устройство подключено, не отвергнуто и не остановлено на другом хосте: одна подписка `connection.watch`, один планировщик. Первая синхронизация — когда `watch` подписался (или не смог): ревизии до подписки не повторяются, и ранний прогон мог бы пропустить коммит между своим запросом и подпиской. Дальше — на каждое событие ревизии; первое событие после переподключения несёт текущую ревизию.
- Подключение в сети:
  - адреса из кода опрашиваются одновременно; код уходит только на адрес, чей сертификат совпал с `f`, без вопроса человеку;
  - при ручном вводе (`host` или `host:порт`, порт по умолчанию 45710) сначала `hello`, затем отпечаток `formatFingerprint(observed)`, и только после «Отпечаток совпадает» — `claim` с наблюдённым отпечатком;
  - код не того вида — «Проверьте код: 10 символов», без обращения к сети;
  - имя устройства — 1–100 символов после обрезки, по умолчанию «Станция»;
  - отказ `claim` никогда не повторяется сам;
  - отказ, после которого хост мог уже принять код (`invalid_response`, `host_changed`, `storage` из `claim`), просит получить новый код: повтор тем же кодом упрётся в `pairing_code_invalid`. `unreachable` из `claim` тоже бывает после приёма (обрыв после отправки), но чаще значит «хост не ответил» — ему оставлен обычный текст: повтор в худшем случае упрётся в `pairing_code_invalid` с просьбой о новом коде.
- Выбор линии:
  - активные линии `ref_lines` (`archived = 0`) по имени через `Intl.Collator("ru", { numeric: true })`;
  - читаются только после удачной синхронизации в этом сеансе и заново после каждой следующей;
  - `line_rejected` — текст, синхронизация, новый список; `key_rejected` — экран отказа.
- Строка связи:
  - «На связи с хостом», «Подключение к хосту…», «Нет связи с хостом с ЧЧ:ММ» (время последней связи по часам этого ПК) или «Нет связи с хостом»;
  - причина — `errors.link.<код>`;
  - тег фазы со словами, `role="status"` и `aria-live="polite"`;
  - блокирующего слоя в офисе нет: каждая страница объясняет свою ошибку.

**Офис**

- Новая ревизия хоста (`Office`, свойство `hostRevision`) — `session.refreshUser()`: имя и роль следуют за хостом сразу. Открытую страницу ревизия не перезагружает: форма не теряет набранное (в том числе у форм, пересоздаваемых по `rev`), а запись поверх более новой встречает `stale_revision`. Свежие данные страница и так читает при каждом открытии: у запросов офиса `staleTime` 0. Ревизия, с которой офис открылся, ничего не перечитывает.
- «Устройства» — раздел «Производство», только администратор, маршрут в `RequireRole`. Колонки:
  - имя и вид;
  - линия — имя из локальной `ref_lines`, иначе первые 8 символов id и «…»;
  - «Подключено»;
  - «Последний раз» (`lastSeenAt`), никогда не «на связи»;
  - доступ — тег «Действует» или «Отозвано».
- Диалог кода:
  - DataMatrix `payload` (`role="img"` с подписью; при ошибке кодировщика — ничего);
  - код группами 5+5, отпечаток `formatFingerprint(f)`, адреса хоста с портом;
  - таймер, «Новый код», текст о пяти неверных попытках.
- Пока диалог открыт, список устройств перечитывается каждые 3 с. Диалог закрывается сам, когда в списке появляется устройство, подключённое после выдачи кода; время выдачи — `expiresAt` минус 10 минут по часам хоста. Закрытие пользователем перечитывает список.

**Код и тексты**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; без `any`, приведений и `!`.
- Только элементы `@markiro/ui`: ESLint запрещает нативные поля и кнопки в `src/`. Колбэки компонентов и члены интерфейсов — свойства-функции.
- Каждый видимый текст — ключ `src/i18n/ru.json`; отсутствующий ключ роняет тесты.
- Запросы офиса — только через `session.call`: `useOfficeQuery` и `useOfficeMutation` с `officeKeys`. Чтение локальных копий в офисе — `useQuery` с ключом `officeKeys.lineNames`: это не запрос к хосту.
- У `fakeHostApi` есть запись для каждого члена `HostApi`.
- `apps/station` и `apps/admin` не меняются. Rust не меняется, кроме теста фикстуры в `proto/tests/fixtures.rs`.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**План 1c2**

- Задачи этого плана идут после плана 1c2 и используют `src/host/connection.ts`, `src/local/executor.ts`, `test/support/local-db.ts`, новые члены `DeviceApi` и коды отказов. Если 1c2 при исполнении что-то переименовал, сверяйтесь с его разделом «Отклонения при исполнении» и правьте здесь имена, а не поведение.
- `ConnectionHandlers` и `ConnectionApi.watch` в плане 1c2 объявлены свойствами-функциями (поправка контроллера: `createTauriConnectionApi` разбирает обработчики деструктуризацией, а методы `@typescript-eslint/unbound-method` разбирать не даёт). Код этого плана вызывает обработчики только на объекте, переданном в `watch`.

**Фрагменты правок**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле, с отступами: ищите его поиском, он встречается в файле один раз. Порядок правок внутри шага — сверху вниз по файлу.
- Перед некоторыми фрагментами стоит `<!-- prettier-ignore -->`: это пометка для форматирования самого плана (иначе prettier сдвинул бы отступы фрагмента), а не часть фрагмента.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --write <файлы>` и `--check` для изменённых TS, TSX, JSON, CSS и MD.
- `git diff --check`.

**pnpm, git и тесты**

- pnpm в песочнице — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.
- В свежем worktree сначала соберите зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'` (`@markiro/domain` и `@markiro/ui` отдают `dist`).
- Тесты, читающие файлы рядом с собой, сначала сохраняют `import.meta.url` в переменную, а потом строят `new URL(…, moduleUrl)`: окружение jsdom переписывает буквальный `new URL(…, import.meta.url)` (см. `test/protocol.test.ts`).
- Поддельные таймеры — только в тесте опроса списка устройств (задача 6): `vi.useFakeTimers({ shouldAdvanceTime: true })` и `vi.useRealTimers()` в `afterEach`.
- Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.

**Cargo**

- Rust меняется только в задаче 2 (тест фикстуры в `proto`). `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` порт не слушает и идёт в песочнице. Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/src/local/reference-sync.ts, test/reference-sync.test.ts                задача 1
apps/standalone/src/host/api.ts, test/api.test.ts                                        задачи 1, 6
apps/standalone/test/support/office.tsx                                                  задачи 1, 3, 6
apps/standalone/proto/fixtures/pairing-codes.json, proto/tests/fixtures.rs               задача 2
apps/standalone/src/host/pairing-code.ts, test/pairing-code.test.ts                      задача 2
apps/standalone/src/app/host-link.ts                                                     задачи 3, 4
apps/standalone/src/app/shell.ts, src/app/screens.tsx                                    задачи 3–5
apps/standalone/src/app/App.tsx, src/i18n/ru.json                                        задачи 3–6
apps/standalone/src/office/Office.tsx                                                    задачи 3, 4, 6
apps/standalone/test/app.test.tsx, test/shell.test.ts                                    задачи 3–5
apps/standalone/test/office.test.tsx                                                     задача 3
apps/standalone/test/support/fixtures.ts                                                 задачи 3, 4
apps/standalone/src/app/{HostStatusLine,LineSelect}.tsx                                  задача 4
apps/standalone/src/office/{office-link,OfficeShell}.tsx                                 задача 4
apps/standalone/test/{host-status-line,line-select}.test.tsx                             задача 4
apps/standalone/src/app/shell.css                                                        задачи 4, 6
apps/standalone/src/app/{host-search.ts,NetworkPairing.tsx}                              задача 5
apps/standalone/test/{host-search.test.ts,network-pairing.test.tsx}                      задача 5
apps/standalone/src/office/devices/{DevicesPage,PairingCodeDialog,PairingDataMatrix}.tsx задача 6
apps/standalone/src/office/{office-local.tsx,office-query.ts,nav.ts,routes.tsx}          задача 6
apps/standalone/test/{devices-page,office-query}.test.tsx                                задача 6
apps/standalone/AGENTS.md                                                                задачи 1–6
спецификация: §5.4 — задача 1; §5.1 — задачи 4, 5; §4.7 — задача 5; §5.5 — задача 6
```

Раскладка задач повторяет список решений контроллера с одной перестановкой: выбор линии и строка связи (там — задача 5) идут четвёртыми, подключение в сети (там — задача 4) — пятым. Так тест приложения в задаче 5 проходит путь второго ПК целиком — код, выбор линии, цех — и ни одна задача не переписывает ожидания предыдущей. Новые виды оболочки приходят вместе со своими экранами: `other_host` — в задаче 3, `line_select` — в задаче 4, `network_pairing` — в задаче 5; экранов-заглушек нет.

---

### Task 1: Синхронизация справочников — `src/local/reference-sync.ts`

Станция хранит справочники у себя, чтобы работать без хоста (спецификация, §5.3–5.4). Эта задача даёт модуль, который приводит локальные копии к ревизии хоста, и планировщик, который не пускает два прогона сразу. Подписка на связь и экраны — задачи 3–5; здесь модуль проверяется на настоящей базе `openLocalDb()` с поддельной лентой.

Решения контроллера соблюдены с одним уточнением. При смене набора сущностей и при откате хоста старые копии удаляются в транзакции первой новой порции, а не отдельной транзакцией до запроса. Иначе неудачный запрос после очистки оставил бы станцию без справочников, пока хост недоступен, а работа без связи — требование продукта (корневой `AGENTS.md`). Копии другого хоста (`host_id`) удаляются сразу: чужие записи не должны оставаться в работе.

**Files:**

- Create: `apps/standalone/src/local/reference-sync.ts`, `apps/standalone/test/reference-sync.test.ts`
- Modify: `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`, `apps/standalone/test/api.test.ts`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.4)

**Interfaces:**

- Consumes (из плана 1c2, задача 5, и плана 1c1):
  - `LocalExecutor.query<T>(sql: string, params: readonly unknown[], row: z.ZodType<T>): Promise<T[]>`, `LocalExecutor.transaction(statements: readonly LocalStatement[]): Promise<number[]>`, `LocalStatement { sql: string; values?: readonly unknown[]; expectedChanges?: number }` — `src/local/executor.ts`;
  - `openLocalDb(): { db: DatabaseSync; executor: LocalExecutor }` — `test/support/local-db.ts`;
  - таблицы `ref_org`, `ref_site`, `ref_lines`, `sync_state` — миграция `src-tauri/migrations/0001_reference_data.sql` (план 1c2, задача 1);
  - `host_request` пропускает `GET /v1/changes` (план 1c2, задача 3);
  - `changesResponseSchema`, `orgRecordSchema`, `siteRecordSchema`, `lineRecordSchema`, типы `ChangeItem`, `ChangesResponse` — `src/host/protocol.ts` (план 1c1);
  - `HOST_ID` — `test/support/fixtures.ts`.
- Produces:
  - `HostApi.getChanges: (since: number) => Promise<ChangesResponse>`;
  - `ENTITY_SET = "org_profile,site,lines"`;
  - `type SyncResult = { kind: "synced"; rev: number } | { kind: "other_host" }`;
  - `interface SyncOptions { changes: (since: number) => Promise<ChangesResponse>; local: LocalExecutor; hostId: string }`;
  - `syncReferences(options: SyncOptions): Promise<SyncResult>`;
  - `interface SyncScheduler { trigger: () => void; stop: () => void }`, `createSyncScheduler(run: () => Promise<void>): SyncScheduler`;
  - ключи `sync_state`: `last_rev`, `host_id`, `entity_set`.

- [ ] **Step 1: Тесты (падающие)**

Create `apps/standalone/test/reference-sync.test.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { createSyncScheduler, ENTITY_SET, syncReferences } from "../src/local/reference-sync.js";
import { HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const LINE_1 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_2 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";

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

describe("reference sync", () => {
  it("copies every record of the first full sync", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(42, [line(LINE_2, 40, "Линия 2", true), ORG, SITE, line(LINE_1, 42, "Линия 1")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
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

  it("follows the feed page by page from the last applied revision", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(41, [ORG, SITE], true),
      41: page(42, [line(LINE_1, 42, "Линия 1")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
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
    // The three upserts found nothing newer; only the sync state was written.
    expect(recorded.batches).toEqual([[0, 0, 0, 3]]);
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
    });
    expect(changes.mock.calls).toEqual([[20], [0]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (из копии)", archived: 0, rev: 12 },
    ]);
    expect(tables(db).state).toEqual(state(12));
  });

  it("gives up when the host goes back twice in one sync", async () => {
    const { executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({
      20: page(12, []),
      0: page(8, [line(LINE_1, 8, "Линия 1")], true),
      8: page(5, []),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /went back twice/,
    );
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
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });

    const changes = feed({ 0: page(5, [line(LINE_1, 5, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 5 }]);
    expect(tables(db).state).toEqual(state(5));
  });

  it("stops at a feed from another host without applying anything", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({ 0: page(42, [ORG, line(LINE_1, 42, "Линия 1")], false, OTHER_HOST) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "other_host",
    });
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });
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

  it("applies nothing of a page with an unreadable record", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    const changes = feed({ 0: page(42, [line(LINE_1, 40, "Линия 1"), broken]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /site record 1/,
    );
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });
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
    });
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
});
```

В `apps/standalone/test/api.test.ts` фрагмент

```ts
  it("rejects a users answer that is not a list", async () => {
```

заменить на

```ts
  it("reads the change feed with the device key only, no office session", async () => {
    const { api, sent } = recording(fixture("changes-response.json"));
    await expect(api.getChanges(41)).resolves.toMatchObject({ rev: 42, hasMore: false });
    expect(sent).toEqual([
      { method: "GET", path: "/v1/changes?since=41", body: undefined, officeToken: undefined },
    ]);
  });

  it("rejects a users answer that is not a list", async () => {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/api.test.ts`
Expected: FAIL — `reference-sync.test.ts` не загружается (нет модуля `src/local/reference-sync.ts`); в `api.test.ts` падает новый тест: `api.getChanges is not a function`.

- [ ] **Step 3: `HostApi.getChanges` и модуль синхронизации**

1. В `apps/standalone/src/host/api.ts` фрагмент

```ts
import {
  bootstrapResponseSchema,
  officeSessionSchema,
```

заменить на

```ts
import {
  bootstrapResponseSchema,
  changesResponseSchema,
  officeSessionSchema,
```

2. Там же фрагмент

```ts
  type BootstrapResponse,
  type OfficeLoginRequest,
```

заменить на

```ts
  type BootstrapResponse,
  type ChangesResponse,
  type OfficeLoginRequest,
```

3. Там же, в конце `interface HostApi`, фрагмент

```ts
  setUserPassword: (token: string, id: string, request: PasswordSet) => Promise<void>;
}
```

заменить на

```ts
  setUserPassword: (token: string, id: string, request: PasswordSet) => Promise<void>;
  /** Reference records changed after revision `since`; the device key only, no office session. */
  getChanges: (since: number) => Promise<ChangesResponse>;
}
```

4. Там же, в конце `createHostApi`, фрагмент

```ts
        schema: NO_CONTENT,
      });
    },
  };
}
```

заменить на

```ts
        schema: NO_CONTENT,
      });
    },
    getChanges: (since) =>
      client.request("GET", `/v1/changes?since=${since}`, { schema: changesResponseSchema }),
  };
}
```

5. В `apps/standalone/test/support/office.tsx` в `fakeHostApi` фрагмент

```tsx
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
```

заменить на

```tsx
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
    getChanges: vi.fn<HostApi["getChanges"]>(() => unexpected("getChanges")),
```

6. Create `apps/standalone/src/local/reference-sync.ts`:

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
 * The feed entities this build keeps, in `sync_state.entity_set`. A build
 * that keeps more (plans 1d and 1e) finds another value there and syncs
 * from zero: the old build skipped those entities, so their records would
 * never come otherwise.
 */
export const ENTITY_SET = "org_profile,site,lines";

export type SyncResult = { kind: "synced"; rev: number } | { kind: "other_host" };

export interface SyncOptions {
  /** `GET /v1/changes?since=<rev>` (`HostApi.getChanges`). */
  changes: (since: number) => Promise<ChangesResponse>;
  local: LocalExecutor;
  /** The host this device is paired with (`DeviceStatus.hostId`). */
  hostId: string;
}

interface EntityTable {
  table: string;
  /** Checks a live record and flattens it, with its key and revision, for `upsert`. */
  row: (item: ChangeItem) => Record<string, unknown>;
  /** Every live record of a page in one statement: `json_each` over the rows. */
  upsert: string;
}

/** A live record's `data`, or an error that leaves the whole page unapplied. */
function checked<T>(schema: z.ZodType<T>, item: ChangeItem): T {
  const parsed = schema.safeParse(item.data);
  if (!parsed.success) {
    throw new Error(`unreadable ${item.entity} record ${item.id}: ${parsed.error.message}`);
  }
  return parsed.data;
}

const ENTITIES: ReadonlyMap<string, EntityTable> = new Map([
  [
    "org_profile",
    {
      table: "ref_org",
      row: (item) => ({ ...checked(orgRecordSchema, item), id: item.id, rev: item.rev }),
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
      row: (item) => ({ ...checked(siteRecordSchema, item), id: item.id, rev: item.rev }),
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
      row: (item) => ({ ...checked(lineRecordSchema, item), id: item.id, rev: item.rev }),
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
 * Deletes the rows that tombstones of the page are newer than: a tombstone
 * older than a row (the key was created again) leaves it alone.
 */
function tombstoneDelete(table: string): string {
  return (
    `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(?) AS t ` +
    `WHERE t.value ->> 'id' = ${table}.id AND t.value ->> 'rev' > ${table}.rev)`
  );
}

/** Every copy and the sync state: the next page applied starts from zero. */
const WIPE: readonly LocalStatement[] = [
  ...[...ENTITIES.values()].map((entity) => ({ sql: `DELETE FROM ${entity.table}` })),
  { sql: "DELETE FROM sync_state" },
];

const WRITE_STATE =
  "INSERT INTO sync_state (key, value) VALUES ('last_rev', ?), ('host_id', ?), ('entity_set', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

const stateRow = z.object({ key: z.string(), value: z.string() });

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
 * One page as one batch: per entity a conditional delete for its tombstones
 * and one upsert for its live records, then the page's revision. Records are
 * checked before anything is written. Entities this build does not keep are
 * skipped. At most one statement per table plus two per entity plus one: 11
 * with the wipe today, within the shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string): LocalStatement[] {
  const statements: LocalStatement[] = [];
  for (const [entity, table] of ENTITIES) {
    const items = page.items.filter((item) => item.entity === entity);
    const tombstones = items.filter((item) => item.deleted).map(({ id, rev }) => ({ id, rev }));
    const live = items.filter((item) => !item.deleted).map((item) => table.row(item));
    if (tombstones.length > 0) {
      statements.push({ sql: tombstoneDelete(table.table), values: [JSON.stringify(tombstones)] });
    }
    if (live.length > 0) statements.push({ sql: table.upsert, values: [JSON.stringify(live)] });
  }
  statements.push({ sql: WRITE_STATE, values: [String(page.rev), hostId, ENTITY_SET] });
  return statements;
}

/**
 * Brings the local copies up to the host's revision (stage 1 spec §5.4):
 * pages of `GET /v1/changes` from the last applied revision until `hasMore`
 * is false, each page in one `local_transaction`. Applying a page again
 * changes nothing: a row changes only for a newer revision. Stops, applying
 * nothing, when the feed comes from another host than the paired one.
 */
export async function syncReferences({ changes, local, hostId }: SyncOptions): Promise<SyncResult> {
  const stored = await readState(local);
  let since = 0;
  let wipe = false;
  if (stored.hostId !== null && stored.hostId !== hostId) {
    // Copies from a pairing with another host must not stay usable while
    // this host is out of reach.
    await local.transaction(WIPE);
  } else if (stored.entitySet === ENTITY_SET && stored.lastRev !== null) {
    since = stored.lastRev;
  } else {
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
      if (wentBack) throw new Error(`the host went back twice in one sync: ${page.rev} < ${since}`);
      wentBack = true;
      since = 0;
      wipe = true;
      continue;
    }
    const statements = pageStatements(page, hostId);
    await local.transaction(wipe ? [...WIPE, ...statements] : statements);
    wipe = false;
    since = page.rev;
    if (!page.hasMore) return { kind: "synced", rev: page.rev };
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
 * after it; a failed run just ends and waits for the next trigger.
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

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/api.test.ts`
Expected: PASS — 14 тестов в `reference-sync.test.ts`, 13 в `api.test.ts`.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` в конец раздела «Change feed» (после предложения, которое кончается словами «re-creating a key deletes its tombstone.») добавить:

```text
On the device side a new entity also needs its entry in `ENTITIES` and in
`ENTITY_SET` (`src/local/reference-sync.ts`); a new `ENTITY_SET` makes
every device sync from zero once.
```

2. Там же после раздела «Change feed» добавить раздел:

```text
## Reference sync

`src/local/reference-sync.ts` keeps the local copies in step with the host
(stage 1 spec §5.4). `syncReferences` reads `sync_state` (`last_rev`,
`host_id`, `entity_set`) and fetches `GET /v1/changes?since=<last_rev>`
(`HostApi.getChanges`, the device key only) until `hasMore` is false. Each
page is one `local_transaction`: per entity one conditional delete for its
tombstones (only rows older than the tombstone) and one `json_each` upsert
for its live records (only when the revision is newer), then the page's
revision. Records are checked with their Zod schemas before anything is
written, so a bad record leaves the whole page unapplied; entities this
build does not keep are skipped, and applying a page again changes nothing.
The copies start from zero when `host_id` names another host (wiped at
once: another host's records must not stay usable), when `entity_set` is
not this build's `ENTITY_SET`, or when the feed answers `rev < since` (the
host went back to an older copy; once per run). The last two drop the old
copies in the transaction of the first new page, so a failed fetch keeps
them. A feed from another host than the paired one stops the sync with
`other_host` and applies nothing. `createSyncScheduler` runs one sync at a
time: triggers during a run ask for exactly one more, and a failed run
waits for the next trigger. A host restored from a copy that has already
passed the device's revision goes unnoticed until the feed carries an
epoch (plan 5).
```

3. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.4, после последнего пункта («… устройство подключено к другому хосту.») добавить пункты:

```text
- удаление по записи `deleted` срабатывает, только если её ревизия новее ревизии
  строки: надгробие не удаляет ключ, созданный заново;
- копии начинаются с нуля, если `sync_state.host_id` называет другой хост (очистка
  сразу: записи чужого хоста не должны оставаться в работе), если сохранённый набор
  сущностей (`entity_set`) не совпадает с набором этой сборки или если лента ответила
  `rev < since` (хост восстановлен из более старой копии; один раз за прогон). В двух
  последних случаях старые копии удаляются в транзакции первой новой порции, чтобы
  неудачный запрос их не стёр;
- синхронизации не идут параллельно: событие во время прогона запрашивает ровно один
  следующий прогон, неудачный прогон ждёт следующего события.
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck` и `… lint`; `git diff --check`.
Expected: всё зелёное.

```bash
git add apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/src/host/api.ts apps/standalone/test/support/office.tsx apps/standalone/test/api.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): синхронизация справочников станции по ленте изменений" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Вид кода подключения и машиночитаемый код в вебвью

Экраны подключения (задача 5) проверяют код до отправки: хост засчитывает неверный код всем живым кодам, так что опечатка не должна до него дойти. Правило вида кода уже есть в Rust (`markiro_proto::pairing::normalize`); здесь оно переписано на TypeScript, и общая фикстура не даёт двум правилам разойтись. Там же разбирается машиночитаемый код из офиса.

Клавиатурный сканер нажимает клавиши, а не печатает символы: при включённой русской раскладке код `markiro-host:1?…` приходит кириллицей. Разбор переводит такой текст обратно в позиции клавиш US. Сверх решений контроллера разбор терпит Caps Lock при раскладке US и идентификатор AIM `]d1`, который добавляют сканеры с включённой передачей символики: коды маркировки `@markiro/domain` так же отбрасывают `]d2` (`packages/domain/src/gs1/km.ts`). Caps Lock при русской раскладке тоже читается: он меняет только регистр кириллических букв, а `:`, `.` и `,` стоят там на буквенных клавишах, поэтому неразобранный текст пробуется ещё раз с обращённым регистром кириллицы (исполнение задачи 2).

**Files:**

- Create: `apps/standalone/proto/fixtures/pairing-codes.json`, `apps/standalone/src/host/pairing-code.ts`, `apps/standalone/test/pairing-code.test.ts`
- Modify: `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes:
  - `markiro_proto::pairing::normalize(input: &str) -> Option<String>` (доработка плана 1c1);
  - `pairingCodeSchema` (`src/host/protocol.ts`) и фикстура `proto/fixtures/pairing-code.json`.
- Produces:
  - `PAIRING_CODE_ALPHABET`, `PAIRING_CODE_LENGTH`;
  - `normalizePairingCode(input: string): string | null`;
  - `interface PairingPayload { addresses: string[]; port: number; fingerprint: string; code: string }`;
  - `fromRussianLayout(text: string): string`;
  - `parsePairingPayload(text: string): PairingPayload | null`;
  - фикстура `proto/fixtures/pairing-codes.json`: `{ "cases": [{ "input": string, "normalized": string | null }] }` — 24 случая;
  - Rust-тест `the_pairing_code_fixture_matches_normalize`.

- [ ] **Step 1: Фикстура и тесты (падающие)**

Create `apps/standalone/proto/fixtures/pairing-codes.json` (символы вне ASCII записаны escape-последовательностями `\u`, чтобы невидимые и похожие на дефис знаки было видно):

```json
{
  "cases": [
    { "input": "7K3MQ9XV2D", "normalized": "7K3MQ9XV2D" },
    { "input": " 7k3mq-9xv2d ", "normalized": "7K3MQ9XV2D" },
    { "input": "7K3MQ-9XV2D-", "normalized": "7K3MQ9XV2D" },
    { "input": "OIL0000000", "normalized": "0110000000" },
    { "input": "oil0000000", "normalized": "0110000000" },
    { "input": "7K3M\tQ9XV\u20132D", "normalized": "7K3MQ9XV2D" },
    { "input": "7K3M\u00a0Q9XV\u22122D", "normalized": "7K3MQ9XV2D" },
    { "input": "7K\u2010\u2011\u2012\u2014\u20153MQ9XV2D", "normalized": "7K3MQ9XV2D" },
    { "input": "7K3MQ9XV2D\u0085", "normalized": "7K3MQ9XV2D" },
    { "input": "\u30007K3MQ9XV2D\u2028", "normalized": "7K3MQ9XV2D" },
    { "input": "7K3MQ9XV2U", "normalized": null },
    { "input": "7K3MQ9XV2", "normalized": null },
    { "input": "7K3MQ9XV2DD", "normalized": null },
    { "input": "7K3MQ9XV2\u0416", "normalized": null },
    { "input": "", "normalized": null },
    { "input": "-----", "normalized": null },
    { "input": "7K3MQ\u20169XV2D", "normalized": null },
    { "input": "7K3MQ\u00ad9XV2D", "normalized": null },
    { "input": "7K3MQ\u200b9XV2D", "normalized": null },
    { "input": "\ufeff7K3MQ9XV2D", "normalized": null },
    { "input": "\u00df7K3MQ9XV2", "normalized": null },
    { "input": "\u0131000000000", "normalized": null },
    { "input": "\u017f000000000", "normalized": null },
    { "input": "\uff17K3MQ9XV2D", "normalized": null }
  ]
}
```

В `apps/standalone/proto/tests/fixtures.rs` в конец файла добавить:

```rust
#[test]
fn the_pairing_code_fixture_matches_normalize() {
    let fixture = fixture("pairing-codes.json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 24);
    for case in cases {
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            markiro_proto::pairing::normalize(input).as_deref(),
            case["normalized"].as_str(),
            "{input:?}"
        );
    }
}
```

Create `apps/standalone/test/pairing-code.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  fromRussianLayout,
  normalizePairingCode,
  parsePairingPayload,
} from "../src/host/pairing-code.js";
import { pairingCodeSchema } from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const CASES = z
  .object({
    cases: z.array(z.object({ input: z.string(), normalized: z.string().nullable() }).strict()),
  })
  .strict()
  .parse(fixture("pairing-codes.json")).cases;

const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;
const PARSED = {
  addresses: ["10.0.0.5", "192.168.1.10"],
  port: 45710,
  fingerprint: FINGERPRINT,
  code: "7K3MQ9XV2D",
};
/** `PAYLOAD` as a keyboard-wedge scanner types it while the Russian layout is on. */
const TYPED_IN_RUSSIAN =
  "ьфклшкщ-рщыеЖ1,р=10ю0ю0ю5б192ю168ю1ю10?з=45710?а=" + "фи".repeat(32) + "?с=7Л3ЬЙ9ЧМ2В";

describe("pairing code", () => {
  it("normalizes every shared case exactly like markiro_proto::pairing::normalize", () => {
    expect(CASES).toHaveLength(24);
    for (const { input, normalized } of CASES) {
      expect(normalizePairingCode(input), JSON.stringify(input)).toBe(normalized);
    }
  });
});

describe("pairing payload", () => {
  it("reads the payload the host builds (proto/fixtures/pairing-code.json)", () => {
    const { payload } = pairingCodeSchema.parse(fixture("pairing-code.json"));
    expect(parsePairingPayload(payload)).toEqual(PARSED);
  });

  it("reads a payload typed under the Russian layout", () => {
    expect(fromRussianLayout(TYPED_IN_RUSSIAN)).toBe(PAYLOAD);
    expect(parsePairingPayload(TYPED_IN_RUSSIAN)).toEqual(PARSED);
  });

  it("reads a payload typed with Caps Lock on", () => {
    const capsLock = `MARKIRO-HOST:1?H=10.0.0.5,192.168.1.10&P=45710&F=${"AB".repeat(32)}&C=7k3mq9xv2d`;
    expect(parsePairingPayload(capsLock)).toEqual(PARSED);
  });

  it("drops the AIM identifier a scanner may prepend and the spaces around", () => {
    expect(parsePairingPayload(`  ]d1${PAYLOAD} `)).toEqual(PARSED);
    expect(parsePairingPayload(`ъв1${TYPED_IN_RUSSIAN}`)).toEqual(PARSED);
  });

  it("reports a payload without addresses so the screen can warn", () => {
    expect(parsePairingPayload(PAYLOAD.replace("10.0.0.5,192.168.1.10", ""))).toEqual({
      ...PARSED,
      addresses: [],
    });
  });

  it("normalizes the code the payload carries", () => {
    expect(parsePairingPayload(PAYLOAD.replace("7K3MQ9XV2D", "7k3mq-9xv2d"))).toEqual(PARSED);
  });

  it.each([
    ["another scheme", PAYLOAD.replace("markiro-host:1", "markiro-host:2")],
    ["no query", "markiro-host:1"],
    ["plain text", "4600682000013"],
    ["a field without a value", `${PAYLOAD}&x`],
    ["a repeated field", `${PAYLOAD}&c=7K3MQ9XV2D`],
    ["no address field", PAYLOAD.replace("h=10.0.0.5,192.168.1.10&", "")],
    ["a host name instead of an address", PAYLOAD.replace("10.0.0.5", "host-pc")],
    ["an address out of range", PAYLOAD.replace("10.0.0.5", "10.0.0.256")],
    ["port 0", PAYLOAD.replace("p=45710", "p=0")],
    ["port 65536", PAYLOAD.replace("p=45710", "p=65536")],
    ["a short fingerprint", PAYLOAD.replace(FINGERPRINT, "ab".repeat(31))],
    ["a fingerprint that is not hex", PAYLOAD.replace(FINGERPRINT, "zz".repeat(32))],
    ["a code that cannot be a code", PAYLOAD.replace("7K3MQ9XV2D", "7K3MQ9XV2U")],
  ])("refuses %s", (_name, text) => {
    expect(parsePairingPayload(text)).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тесты**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS — 20 тестов. Правило Rust уже есть: этот тест закрепляет его ответы в фикстуре, чтобы TypeScript сверялся с ними.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/pairing-code.test.ts`
Expected: FAIL — нет модуля `src/host/pairing-code.ts`.

- [ ] **Step 3: Модуль `pairing-code.ts`**

Create `apps/standalone/src/host/pairing-code.ts`:

```ts
/**
 * Pairing-code input in the webview (stage 1 spec §4.7): a code typed from
 * the office screen, or the whole DataMatrix payload read by a scanner.
 * `normalizePairingCode` is `markiro_proto::pairing::normalize` rewritten:
 * `proto/fixtures/pairing-codes.json` pins the two to the same answers.
 */

/** Crockford base32: no I, L, O or U (`markiro_proto::pairing::ALPHABET`). */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 10;

/** Unicode White_Space, exactly what Rust's `char::is_whitespace` accepts. */
const WHITE_SPACE = /^\p{White_Space}$/u;
/** The ASCII hyphen, the dashes U+2010..U+2015 and the minus sign U+2212. */
const DASH = /^[-\u2010-\u2015\u2212]$/;

/**
 * The canonical form of a typed or scanned code: separators skipped (any
 * white space and the dashes above), ASCII letters upper-cased, O read as
 * 0, I and L as 1. `null` when the input cannot be a code.
 */
export function normalizePairingCode(input: string): string | null {
  let code = "";
  for (const symbol of input) {
    if (WHITE_SPACE.test(symbol) || DASH.test(symbol)) continue;
    // ASCII only: `toUpperCase` would turn "ß" into "SS" and "ı" into "I".
    const upper = /^[a-z]$/.test(symbol) ? symbol.toUpperCase() : symbol;
    const canonical = upper === "O" ? "0" : upper === "I" || upper === "L" ? "1" : upper;
    if (canonical.length !== 1 || !PAIRING_CODE_ALPHABET.includes(canonical)) return null;
    code += canonical;
    if (code.length > PAIRING_CODE_LENGTH) return null;
  }
  return code.length === PAIRING_CODE_LENGTH ? code : null;
}

/** What the office's DataMatrix carries: `markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`. */
export interface PairingPayload {
  /** The host's IPv4 addresses in the local network; empty when it has none. */
  addresses: string[];
  port: number;
  /** Lower-case hex SHA-256 of the host's certificate. */
  fingerprint: string;
  /** The code in canonical form. */
  code: string;
}

/**
 * The Russian ЙЦУКЕН layout back to the US keys, position by position. A
 * keyboard-wedge scanner presses keys, not characters: with the Russian
 * layout on, the payload arrives in Cyrillic. Digits, `-`, `=` and space sit
 * on the same keys in both layouts.
 */
const RUSSIAN_KEYS =
  "йцукенгшщзхъфывапролджэячсмитьбюё" + "ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁ" + '.,"№;:?/';
const US_KEYS =
  "qwertyuiop[]asdfghjkl;'zxcvbnm,.`" + 'QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>~' + "/?@#$^&|";
const RUSSIAN_TO_US = new Map(
  Array.from(RUSSIAN_KEYS, (symbol, index) => [symbol, US_KEYS.charAt(index)] as const),
);

/** Text typed under the Russian layout, as the same keys type it under the US one. */
export function fromRussianLayout(text: string): string {
  return Array.from(text, (symbol) => RUSSIAN_TO_US.get(symbol) ?? symbol).join("");
}

const CYRILLIC = /[\u0400-\u04ff]/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function isIpv4(address: string): boolean {
  const match = IPV4.exec(address);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * The office's pairing payload, as a scanner typed it: under the Russian
 * layout, with Caps Lock, or behind the AIM identifier `]d1` a scanner may
 * prepend. `null` when the text is not a payload of protocol 1.
 */
export function parsePairingPayload(text: string): PairingPayload | null {
  const typed = (CYRILLIC.test(text) ? fromRussianLayout(text) : text).trim();
  const body = typed.replace(/^\]d\d/, "");
  const query = body.indexOf("?");
  if (query < 0 || body.slice(0, query).toLowerCase() !== "markiro-host:1") return null;
  const fields = new Map<string, string>();
  for (const field of body.slice(query + 1).split("&")) {
    const equals = field.indexOf("=");
    if (equals < 0) return null;
    const key = field.slice(0, equals).toLowerCase();
    if (fields.has(key)) return null;
    fields.set(key, field.slice(equals + 1));
  }
  const hosts = fields.get("h");
  const port = fields.get("p");
  const fingerprint = fields.get("f")?.toLowerCase();
  const code = normalizePairingCode(fields.get("c") ?? "");
  if (hosts === undefined || port === undefined || fingerprint === undefined || code === null) {
    return null;
  }
  const addresses = hosts === "" ? [] : hosts.split(",");
  const portNumber = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  if (!addresses.every(isIpv4) || portNumber < 1 || portNumber > 65535) return null;
  if (!FINGERPRINT.test(fingerprint)) return null;
  return { addresses, port: portNumber, fingerprint, code };
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/pairing-code.test.ts`
Expected: PASS — 20 тестов.

- [ ] **Step 5: Документы**

В `apps/standalone/AGENTS.md` в конец раздела «Local pairing trust» добавить абзац:

```text
The webview checks a typed code with `normalizePairingCode` and reads the
office's DataMatrix payload with `parsePairingPayload`
(`src/host/pairing-code.ts`), including a payload a keyboard-wedge scanner
typed under the Russian layout. `normalizePairingCode` is
`markiro_proto::pairing::normalize` rewritten: `proto/fixtures/pairing-codes.json`
holds the cases both must answer alike, and the Rust and Vitest suites check
every one, so changing either rule means changing the fixture.
```

Затем `node_modules/.bin/prettier --write` и `--check` на `AGENTS.md`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`; `git diff --check`.
Expected: всё зелёное.

```bash
git add apps/standalone/proto/fixtures/pairing-codes.json apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/pairing-code.ts apps/standalone/test/pairing-code.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): вид кода подключения и разбор машиночитаемого кода в вебвью" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Связь с хостом и синхронизация в оболочке, другой хост, офис по ревизии

Пока устройство подключено, приложение держит одну подписку на связь с хостом и один планировщик синхронизации (`useHostLink`). Синхронизация идёт при старте и на каждое событие ревизии. Первое событие после переподключения несёт текущую ревизию хоста, так что догонять пропущенное отдельно не нужно (спецификация, §5.4). Оболочка запоминает:

- статус связи — строка связи появится в задаче 4;
- ход синхронизации — выбор линии читает копии после неё;
- последнюю ревизию хоста — по ней офис перечитывает свои данные и пользователя. Это отложенный пункт плана 1b3: повышение роли иначе видно только после нового входа.

Отказ ключа или смена сертификата на связи — тот же отказ устройства, что и на запросе офиса. Лента другого хоста останавливает синхронизацию и выводит экран «Устройство подключено к другому хосту» с тем же ремонтом: забыть подключение и подключиться заново (спецификация, §5.4).

Экран отказа для хоста не на этом ПК получает свой текст: прежний говорит «хост на этом компьютере сменился», а второй ПК теперь получает этот экран от своей связи с удалённым хостом.

**Files:**

- Create: `apps/standalone/src/app/host-link.ts`
- Modify: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/screens.tsx`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/test/app.test.tsx`, `apps/standalone/test/shell.test.ts`, `apps/standalone/test/office.test.tsx`, `apps/standalone/test/support/office.tsx`, `apps/standalone/test/support/fixtures.ts`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes:
  - из плана 1c2, задача 5: `ConnectionApi.watch(handlers: ConnectionHandlers): Promise<() => void>`, `ConnectionHandlers { onStatus(status: HostStatus): void; onRevision(rev: number): void }`, `createTauriConnectionApi(): ConnectionApi` (`src/host/connection.ts`), `HostStatus` (`src/host/protocol.ts`), `createTauriLocalExecutor(): LocalExecutor`, `openLocalDb()`;
  - задача 1: `syncReferences`, `createSyncScheduler`, `SyncResult`, `HostApi.getChanges`;
  - `shellActionFor(error: unknown, token: string | null): ShellAction | null`, `OfficeSessionValue.refreshUser: () => Promise<void>`.
- Produces:
  - `interface SyncState { kind: "idle" | "running" | "done" | "failed" | "other_host"; synced: number }`;
  - `ShellState.link: HostStatus | null`, `ShellState.sync: SyncState`, `ShellState.hostRevision: number | null`;
  - действия `{ type: "link_status"; status: HostStatus }`, `{ type: "host_revision"; rev: number }`, `{ type: "sync_started" }`, `{ type: "sync_finished"; result: SyncResult }`, `{ type: "sync_failed" }`;
  - вид `{ kind: "other_host"; hostAddress: string }`;
  - `interface HostLinkOptions { hostId: string | null; connection: ConnectionApi; local: LocalExecutor; changes: (since: number) => Promise<ChangesResponse>; dispatch: (action: ShellAction) => void }`, `useHostLink(options: HostLinkOptions): void` (`src/app/host-link.ts`);
  - `OtherHostScreen({ hostAddress, busy, error, onRepair })`; у `DeviceRejectedScreen` новое свойство `remoteAddress: string | null`;
  - `AppProps.connection?: ConnectionApi`, `AppProps.local?: LocalExecutor`;
  - `OfficeProps.hostRevision?: number | null`;
  - в тестах: `renderOffice(session, props?)`, `LINE_ID` в `test/support/fixtures.ts`, `fakeConnection()` в `test/app.test.tsx`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/support/fixtures.ts` фрагмент

```ts
export const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
```

заменить на

```ts
export const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const LINE_ID = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

2. В `apps/standalone/test/support/office.tsx` фрагмент

```tsx
import { Office } from "../../src/office/Office.js";
```

заменить на

```tsx
import { Office, type OfficeProps } from "../../src/office/Office.js";
```

и фрагмент

```tsx
/** The office as the shell renders it, in the dark theme. */
export function renderOffice(session: OfficeSessionValue): RenderResult {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} />
    </ThemeProvider>,
  );
}
```

заменить на

```tsx
/** The office as the shell renders it, in the dark theme. */
export function renderOffice(
  session: OfficeSessionValue,
  props: Omit<OfficeProps, "session"> = {},
): RenderResult {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} {...props} />
    </ThemeProvider>,
  );
}
```

3. В `apps/standalone/test/shell.test.ts` фрагмент

```ts
  shellReducer,
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
```

заменить на

```ts
  shellReducer,
  type ShellAction,
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import type { HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
```

и фрагмент

```ts
function paired(overrides: Partial<ShellState> = {}): ShellState {
```

заменить на

```ts
function linkStatus(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    state: "online",
    lastContactAt: 1_790_000_000_000,
    lastError: null,
    seq: 3,
    ...overrides,
  };
}

function paired(overrides: Partial<ShellState> = {}): ShellState {
```

и фрагмент

```ts
describe("shellActionFor", () => {
```

заменить на

```ts
describe("link and reference sync", () => {
  it("keeps the link status the shell reports", () => {
    expect(shellReducer(paired(), { type: "link_status", status: linkStatus() }).link).toEqual(
      linkStatus(),
    );
  });

  it("treats a refused key or a changed certificate on the link as a rejected device", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const refused = shellReducer(open, {
      type: "link_status",
      status: linkStatus({ state: "offline", lastError: "key_rejected" }),
    });
    expect(refused.rejection).toBe("key_rejected");
    expect(refused.office).toEqual({ kind: "closed" });
    const changed = shellReducer(paired(), {
      type: "link_status",
      status: linkStatus({ state: "connecting", lastError: "certificate_mismatch" }),
    });
    expect(nextShellView(changed, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "host_changed",
    });
    const unreachable = shellReducer(paired(), {
      type: "link_status",
      status: linkStatus({ state: "offline", lastError: "unreachable" }),
    });
    expect(unreachable.rejection).toBeNull();
    expect(nextShellView(unreachable, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("keeps the latest revision the host announced", () => {
    expect(shellReducer(paired(), { type: "host_revision", rev: 42 }).hostRevision).toBe(42);
  });

  it("counts the syncs that brought the copies up to date", () => {
    const running = shellReducer(paired(), { type: "sync_started" });
    expect(running.sync).toEqual({ kind: "running", synced: 0 });
    const done = shellReducer(running, {
      type: "sync_finished",
      result: { kind: "synced", rev: 42 },
    });
    expect(done.sync).toEqual({ kind: "done", synced: 1 });
    const again = shellReducer(done, { type: "sync_started" });
    expect(again.sync).toEqual({ kind: "running", synced: 1 });
    expect(shellReducer(again, { type: "sync_failed" }).sync).toEqual({
      kind: "failed",
      synced: 1,
    });
  });

  it("stops at another host before anything else but a rejected device", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const other = shellReducer(open, { type: "sync_finished", result: { kind: "other_host" } });
    expect(other.office).toEqual({ kind: "closed" });
    expect(nextShellView(other, ADDRESS)).toEqual({
      kind: "other_host",
      hostAddress: DEVICE_STATUS.hostAddress,
    });
    expect(nextShellView({ ...other, rejection: "key_rejected" }, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "key_rejected",
    });
  });

  it("forgets the link, the sync and the revision with the pairing", () => {
    const actions: ShellAction[] = [
      { type: "link_status", status: linkStatus() },
      { type: "host_revision", rev: 42 },
      { type: "sync_finished", result: { kind: "other_host" } },
    ];
    const forgotten = shellReducer(actions.reduce(shellReducer, paired()), { type: "forgotten" });
    expect(forgotten.link).toBeNull();
    expect(forgotten.hostRevision).toBeNull();
    expect(forgotten.sync).toEqual({ kind: "idle", synced: 0 });
  });
});

describe("shellActionFor", () => {
```

4. В `apps/standalone/test/office.test.tsx` фрагмент

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { OfficeLogin } from "../src/office/OfficeLogin.js";
```

заменить на

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import { Office } from "../src/office/Office.js";
import { OfficeLogin } from "../src/office/OfficeLogin.js";
```

и фрагмент

```tsx
  it("moves focus to the page after a menu navigation", async () => {
```

заменить на

```tsx
  it("re-reads the signed-in user on a new host revision and leaves the open page alone", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    const view = renderOffice(session, { hostRevision: 3 });
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    // The revision the office opened with is not news.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
    expect(session.refreshUser).not.toHaveBeenCalled();

    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} hostRevision={4} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(session.refreshUser).toHaveBeenCalledTimes(1));
    // The open form is not reloaded under the user.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the page after a menu navigation", async () => {
```

5. В `apps/standalone/test/app.test.tsx`:

- импорты и помощники — фрагмент

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
```

заменить на

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
```

и фрагмент

```tsx
import { HostError } from "../src/host/client.js";
import { DeviceError, type DeviceApi } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type { DeviceStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
import { fakeHostApi, ORG_PROFILE } from "./support/office.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

const ADDRESS = "https://127.0.0.1:45710";
```

заменить на

```tsx
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { DeviceError, type DeviceApi } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type {
  ChangeItem,
  ChangesResponse,
  DeviceStatus,
  HostStatus,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_STATUS, HOST_ID, LINE_ID, observation, SESSION } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeHostApi, ORG_PROFILE } from "./support/office.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

const ADDRESS = "https://127.0.0.1:45710";
const REMOTE_ADDRESS = "https://192.168.1.10:45710";
const OTHER_HOST_ID = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const ONLINE: HostStatus = {
  state: "online",
  lastContactAt: 1_790_000_000_000,
  lastError: null,
  seq: 1,
};

function feedPage(rev: number, items: ChangeItem[] = [], hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: false, items };
}

function lineItem(rev: number, name: string): ChangeItem {
  return { entity: "lines", id: LINE_ID, rev, deleted: false, data: { name, archived: false } };
}

/**
 * The shell's link as the test drives it: `watch` reports "online" at once,
 * `status` and `revision` reach the app like shell events.
 */
function fakeConnection() {
  let handlers: ConnectionHandlers | null = null;
  const stop = vi.fn();
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      next.onStatus(ONLINE);
      return () => {
        handlers = null;
        stop();
      };
    }),
  };
  return {
    connection,
    stop,
    status: (status: HostStatus) => act(() => handlers?.onStatus(status)),
    revision: (rev: number) => act(() => handlers?.onRevision(rev)),
  };
}
```

- `fakeHost` и `renderApp` — фрагмент

```tsx
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(async () => undefined),
  });
}

function renderApp(services: { probe: HostProbe; device: DeviceApi; host: HostApi }) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <App {...services} address={ADDRESS} />
    </ThemeProvider>,
  );
}
```

заменить на

```tsx
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(async () => undefined),
    getChanges: vi.fn<HostApi["getChanges"]>(async () => feedPage(0)),
  });
}

interface Services {
  probe: HostProbe;
  device: DeviceApi;
  host: HostApi;
  connection?: ConnectionApi;
  local?: LocalExecutor;
}

/** The app with fakes; the link stays online and the local database is a fresh one. */
function renderApp({
  connection = fakeConnection().connection,
  local = openLocalDb().executor,
  ...services
}: Services) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <App {...services} connection={connection} local={local} address={ADDRESS} />
    </ThemeProvider>,
  );
}
```

- тест под `StrictMode` — фрагмент

<!-- prettier-ignore -->
```tsx
          <App probe={probeAnswering(true)} device={device} host={host} address={ADDRESS} />
```

заменить на

<!-- prettier-ignore -->
```tsx
          <App
            probe={probeAnswering(true)}
            device={device}
            host={host}
            connection={fakeConnection().connection}
            local={openLocalDb().executor}
            address={ADDRESS}
          />
```

- новые тесты в конец `describe("App")` — фрагмент

```tsx
    expect(host.getOrg).toHaveBeenLastCalledWith("second-session-token");
  });
});
```

заменить на

```tsx
    expect(host.getOrg).toHaveBeenLastCalledWith("second-session-token");
  });

  it("keeps the local copies in step with the host: at start and after every revision", async () => {
    const { db, executor } = openLocalDb();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges
      .mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]))
      .mockResolvedValueOnce(feedPage(43, [lineItem(43, "Линия 1 (упаковка)")]));
    const lineNames = () =>
      Array.from(db.prepare("SELECT name FROM ref_lines").all(), (row) => row.name);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: executor,
    });
    await waitFor(() => expect(lineNames()).toEqual(["Линия 1"]));
    expect(host.getChanges).toHaveBeenCalledWith(0);

    link.revision(43);
    await waitFor(() => expect(lineNames()).toEqual(["Линия 1 (упаковка)"]));
    expect(host.getChanges).toHaveBeenLastCalledWith(42);
  });

  it("sends a device whose key the host refuses on the link to pairing again", async () => {
    const link = fakeConnection();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    link.status({ state: "offline", lastContactAt: null, lastError: "key_rejected", seq: 2 });
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    expect(
      screen.getByText(
        "Хост не узнаёт ключ этого устройства: устройство могли отключить в офисе или восстановить базу хоста из копии.",
      ),
    ).toBeTruthy();
    // The link stops with the pairing it no longer serves.
    expect(link.stop).toHaveBeenCalledTimes(1);
  });

  it("names the remote host whose certificate changed on the link", async () => {
    const link = fakeConnection();
    renderApp({
      probe: probeAnswering(new HostProbeError("unreachable", "no host on this computer")),
      device: fakeDevice({ ...DEVICE_STATUS, hostAddress: REMOTE_ADDRESS }),
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "certificate_mismatch",
      seq: 2,
    });
    expect(
      await screen.findByText(
        `Хост по адресу ${REMOTE_ADDRESS} сменился: его сертификат не совпадает с сохранённым при подключении.`,
      ),
    ).toBeTruthy();
  });

  it("stops at a host that is not the paired one and pairs again from scratch", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(7, [], OTHER_HOST_ID));
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    expect(
      screen.getByText(
        `По адресу ${ADDRESS} отвечает хост, к которому это устройство не подключали. Справочники с него не загружаются. Подключите устройство заново.`,
      ),
    ).toBeTruthy();
    expect(link.stop).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("reads open office data and the user again when the host announces a revision", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getOrg.mockResolvedValue(ORG_PROFILE);
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    expect(host.getOrg).toHaveBeenCalledTimes(1);

    link.revision(44);
    await waitFor(() => expect(host.getOrg).toHaveBeenCalledTimes(2));
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
  });
});
```

- [ ] **Step 2: Запустить тесты — новые падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx test/office.test.tsx`
Expected: FAIL — новые тесты: редьюсер не знает новых действий (`TypeError` на `undefined`), `getChanges` не вызывается, экранов отказа по связи и другого хоста нет, офис не перечитывает данные. Прежние тесты проходят.

- [ ] **Step 3: Состояние оболочки, `useHostLink`, экраны и офис**

1. В `apps/standalone/src/app/shell.ts` фрагмент

```ts
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, OfficeSession, OfficeUser } from "../host/protocol.js";
```

заменить на

```ts
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, HostStatus, OfficeSession, OfficeUser } from "../host/protocol.js";
import type { SyncResult } from "../local/reference-sync.js";
```

2. Там же фрагмент

```ts
export interface ShellState {
  device: DeviceState;
  localHost: LocalHostState;
  pairing: PairingState;
  rejection: RejectionReason | null;
  office: OfficeState;
}
```

заменить на

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

export interface ShellState {
  device: DeviceState;
  localHost: LocalHostState;
  pairing: PairingState;
  rejection: RejectionReason | null;
  office: OfficeState;
  /** The link to the host as the shell reports it; `null` before the first status. */
  link: HostStatus | null;
  sync: SyncState;
  /** The latest revision the host announced; open office data reloads when it changes. */
  hostRevision: number | null;
}
```

3. Там же фрагмент

```ts
  | { kind: "device_rejected"; reason: RejectionReason }
  | { kind: "floor" }
```

заменить на

```ts
  | { kind: "device_rejected"; reason: RejectionReason }
  | { kind: "other_host"; hostAddress: string }
  | { kind: "floor" }
```

4. Там же фрагмент

```ts
  | { type: "office_user_refreshed"; token: string; user: OfficeUser };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };

export const initialShellState: ShellState = {
  device: { kind: "loading" },
  localHost: { kind: "probing" },
  pairing: { kind: "idle" },
  rejection: null,
  office: CLOSED_OFFICE,
};
```

заменить на

```ts
  | { type: "office_user_refreshed"; token: string; user: OfficeUser }
  | { type: "link_status"; status: HostStatus }
  | { type: "host_revision"; rev: number }
  | { type: "sync_started" }
  | { type: "sync_finished"; result: SyncResult }
  | { type: "sync_failed" };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0 };

export const initialShellState: ShellState = {
  device: { kind: "loading" },
  localHost: { kind: "probing" },
  pairing: { kind: "idle" },
  rejection: null,
  office: CLOSED_OFFICE,
  link: null,
  sync: IDLE_SYNC,
  hostRevision: null,
};

/**
 * A link failure that no retry can cure: the host refuses this device's key,
 * or presents another certificate than the one pinned at pairing.
 */
function linkRejection(status: HostStatus): RejectionReason | null {
  if (status.lastError === "key_rejected") return "key_rejected";
  if (status.lastError === "certificate_mismatch") return "host_changed";
  return null;
}
```

5. Там же, в `nextShellView`, фрагмент

```ts
  if (state.rejection) return { kind: "device_rejected", reason: state.rejection };
  if (status.hostAddress === localAddress) {
```

заменить на

```ts
  if (state.rejection) return { kind: "device_rejected", reason: state.rejection };
  if (state.sync.kind === "other_host") {
    return { kind: "other_host", hostAddress: status.hostAddress };
  }
  if (status.hostAddress === localAddress) {
```

6. Там же, в `shellReducer`, фрагмент

```ts
    case "forgotten":
      return {
        ...state,
        device: { kind: "ready", status: null },
        pairing: { kind: "idle" },
        rejection: null,
        office: CLOSED_OFFICE,
      };
```

заменить на

```ts
    case "forgotten":
      return {
        ...state,
        device: { kind: "ready", status: null },
        pairing: { kind: "idle" },
        rejection: null,
        office: CLOSED_OFFICE,
        link: null,
        sync: IDLE_SYNC,
        hostRevision: null,
      };
```

и в конце `switch` фрагмент

```ts
        office: { kind: "open", session: { ...state.office.session, user: action.user } },
      };
  }
}
```

заменить на

```ts
        office: { kind: "open", session: { ...state.office.session, user: action.user } },
      };
    case "link_status": {
      const rejection = linkRejection(action.status);
      if (rejection === null) return { ...state, link: action.status };
      return { ...state, link: action.status, rejection, office: CLOSED_OFFICE };
    }
    case "host_revision":
      return { ...state, hostRevision: action.rev };
    case "sync_started":
      return { ...state, sync: { ...state.sync, kind: "running" } };
    case "sync_finished":
      if (action.result.kind === "other_host") {
        // Office requests would reach a host this device was never paired with.
        return { ...state, sync: { ...state.sync, kind: "other_host" }, office: CLOSED_OFFICE };
      }
      return { ...state, sync: { kind: "done", synced: state.sync.synced + 1 } };
    case "sync_failed":
      return { ...state, sync: { ...state.sync, kind: "failed" } };
  }
}
```

7. Create `apps/standalone/src/app/host-link.ts`:

```ts
import { useEffect } from "react";

import type { ConnectionApi } from "../host/connection.js";
import type { ChangesResponse } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { createSyncScheduler, syncReferences } from "../local/reference-sync.js";
import { shellActionFor, type ShellAction } from "./shell.js";

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
 * reconnect carries the host's current
 * revision, so catching up needs nothing more.
 */
export function useHostLink({
  hostId,
  connection,
  local,
  changes,
  dispatch,
}: HostLinkOptions): void {
  useEffect(() => {
    if (hostId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
    let active = true;
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
      dispatch({ type: "sync_started" });
      try {
        const result = await syncReferences({ changes, local, hostId });
        if (active) dispatch({ type: "sync_finished", result });
      } catch (error) {
        if (!active) return;
        // A rejected key or a changed certificate needs a new pairing.
        const action = shellActionFor(error, null);
        if (action) dispatch(action);
        dispatch({ type: "sync_failed" });
      }
    });
    let unwatch: (() => void) | null = null;
    connection
      .watch({
        onStatus: (status) => {
          if (active) dispatch({ type: "link_status", status });
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
      scheduler.stop();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, dispatch]);
}
```

8. В `apps/standalone/src/app/screens.tsx` функцию `DeviceRejectedScreen` заменить и после неё добавить `OtherHostScreen` — фрагмент

```tsx
export function DeviceRejectedScreen({
  reason,
  busy,
  error,
  onRepair,
}: {
  reason: RejectionReason;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.deviceRejected.title")} titleAs="h2">
      <Alert tone="warn">
        {t(
          reason === "key_rejected"
            ? "shell.deviceRejected.keyRejected"
            : "shell.deviceRejected.hostChanged",
        )}
      </Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.deviceRejected.repair")}
      </Button>
    </Card>
  );
}
```

заменить на

```tsx
export function DeviceRejectedScreen({
  reason,
  remoteAddress,
  busy,
  error,
  onRepair,
}: {
  reason: RejectionReason;
  /** The paired host's address when that host is not on this computer. */
  remoteAddress: string | null;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  let explanation = t("shell.deviceRejected.keyRejected");
  if (reason === "host_changed") {
    explanation =
      remoteAddress === null
        ? t("shell.deviceRejected.hostChanged")
        : t("shell.deviceRejected.hostChangedRemote", { address: remoteAddress });
  }
  return (
    <Card className="standalone-card" title={t("shell.deviceRejected.title")} titleAs="h2">
      <Alert tone="warn">{explanation}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.deviceRejected.repair")}
      </Button>
    </Card>
  );
}

/**
 * The change feed came from another host than the paired one (spec §5.4):
 * nothing more is synced, and the device pairs again from scratch.
 */
export function OtherHostScreen({
  hostAddress,
  busy,
  error,
  onRepair,
}: {
  hostAddress: string;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.otherHost.title")} titleAs="h2">
      <Alert tone="warn">{t("shell.otherHost.body", { address: hostAddress })}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.otherHost.repair")}
      </Button>
    </Card>
  );
}
```

9. В `apps/standalone/src/app/App.tsx`:

- фрагмент

```tsx
import { createTauriHostClient, HostError } from "../host/client.js";
```

заменить на

```tsx
import { createTauriHostClient, HostError } from "../host/client.js";
import { createTauriConnectionApi, type ConnectionApi } from "../host/connection.js";
```

- фрагмент

```tsx
} from "../host/protocol.js";
import { Office } from "../office/Office.js";
```

заменить на

```tsx
} from "../host/protocol.js";
import { createTauriLocalExecutor, type LocalExecutor } from "../local/executor.js";
import { Office } from "../office/Office.js";
```

- фрагмент

```tsx
import { BootstrapWizard } from "../wizard/BootstrapWizard.js";
import {
  ConfigErrorScreen,
  DeviceRejectedScreen,
  FloorScreen,
  HostMissingScreen,
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
```

заменить на

```tsx
import { BootstrapWizard } from "../wizard/BootstrapWizard.js";
import { useHostLink } from "./host-link.js";
import {
  ConfigErrorScreen,
  DeviceRejectedScreen,
  FloorScreen,
  HostMissingScreen,
  OtherHostScreen,
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
```

- фрагмент

```tsx
export interface AppProps {
  probe?: HostProbe;
  device?: DeviceApi;
  host?: HostApi;
  address?: string;
}

export function App({ probe, device, host, address = LOCAL_HOST_ADDRESS }: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const deviceApi = useMemo(() => device ?? createTauriDeviceApi(), [device]);
  const hostApi = useMemo(() => host ?? createHostApi(createTauriHostClient()), [host]);
```

заменить на

```tsx
export interface AppProps {
  probe?: HostProbe;
  device?: DeviceApi;
  host?: HostApi;
  connection?: ConnectionApi;
  local?: LocalExecutor;
  address?: string;
}

export function App({
  probe,
  device,
  host,
  connection,
  local,
  address = LOCAL_HOST_ADDRESS,
}: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const deviceApi = useMemo(() => device ?? createTauriDeviceApi(), [device]);
  const hostApi = useMemo(() => host ?? createHostApi(createTauriHostClient()), [host]);
  const connectionApi = useMemo(() => connection ?? createTauriConnectionApi(), [connection]);
  const localDb = useMemo(() => local ?? createTauriLocalExecutor(), [local]);
```

- фрагмент

<!-- prettier-ignore -->
```tsx
  const view = nextShellView(state, address);
  const localName = t("device.localName");
```

заменить на

<!-- prettier-ignore -->
```tsx
  const view = nextShellView(state, address);
  const localName = t("device.localName");
  const pairedStatus = state.device.kind === "ready" ? state.device.status : null;
  // The pairing's host when it is not the one on this computer.
  const remoteAddress =
    pairedStatus !== null && pairedStatus.hostAddress !== address ? pairedStatus.hostAddress : null;

  useHostLink({
    hostId:
      pairedStatus !== null && state.rejection === null && state.sync.kind !== "other_host"
        ? pairedStatus.hostId
        : null,
    connection: connectionApi,
    local: localDb,
    changes: hostApi.getChanges,
    dispatch,
  });
```

- фрагмент

<!-- prettier-ignore -->
```tsx
  if (session && officeSession) return <Office key={session.token} session={officeSession} />;
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (session && officeSession) {
    return <Office key={session.token} session={officeSession} hostRevision={state.hostRevision} />;
  }
```

- фрагмент

```tsx
        <DeviceRejectedScreen
          reason={view.reason}
          busy={repairBusy}
          error={repairError}
          onRepair={repair}
        />
      )}
```

заменить на

```tsx
        <DeviceRejectedScreen
          reason={view.reason}
          remoteAddress={remoteAddress}
          busy={repairBusy}
          error={repairError}
          onRepair={repair}
        />
      )}
      {view.kind === "other_host" && (
        <OtherHostScreen
          hostAddress={view.hostAddress}
          busy={repairBusy}
          error={repairError}
          onRepair={repair}
        />
      )}
```

10. В `apps/standalone/src/office/Office.tsx`:

- фрагмент

```tsx
import { useState } from "react";
```

заменить на

```tsx
import { useEffect, useRef, useState } from "react";
```

- фрагмент

```tsx
export interface OfficeProps {
  session: OfficeSessionValue;
}
```

заменить на

```tsx
export interface OfficeProps {
  session: OfficeSessionValue;
  /**
   * The latest revision the host announced (`null` before the first). When
   * it changes, the signed-in user is read again, so a new name or role
   * shows without a new sign-in. Open pages are not reloaded under the user.
   */
  hostRevision?: number | null;
}
```

- фрагмент

```tsx
export function Office({ session }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
```

заменить на

```tsx
export function Office({ session, hostRevision = null }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  const shownRevision = useRef(hostRevision);
  useEffect(() => {
    if (shownRevision.current === hostRevision) return;
    shownRevision.current = hostRevision;
    // The user's name and role follow the host at once. Pages read fresh
    // data whenever they open (`staleTime` 0); an open page is not reloaded
    // under the user, so a form keeps what was typed and a save over a newer
    // record meets `stale_revision` instead of losing the edits silently.
    void session.refreshUser().catch(() => undefined);
  }, [hostRevision, session]);
```

11. В `apps/standalone/src/i18n/ru.json` фрагмент

```json
      "hostChanged": "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
      "repair": "Подключить заново"
    }
  },
```

заменить на

```json
      "hostChanged": "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
      "hostChangedRemote": "Хост по адресу {{address}} сменился: его сертификат не совпадает с сохранённым при подключении.",
      "repair": "Подключить заново"
    },
    "otherHost": {
      "title": "Устройство подключено к другому хосту",
      "body": "По адресу {{address}} отвечает хост, к которому это устройство не подключали. Справочники с него не загружаются. Подключите устройство заново.",
      "repair": "Подключить заново"
    }
  },
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx test/office.test.tsx`
Expected: PASS — 29 тестов в `shell.test.ts`, 28 в `app.test.tsx`, 23 в `office.test.tsx`; в выводе нет предупреждений `act(...)`.

- [ ] **Step 5: Документы**

В `apps/standalone/AGENTS.md` перед разделом «Office pages» добавить раздел:

```text
## App shell

`src/app/shell.ts` holds the screen state; `nextShellView` picks the screen
in a fixed order: the device config, pairing, a rejected device, another
host, the local host's version and identity, then the office or the floor.
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
shell's link and syncs reference data at start and after every revision
event; it stops when the pairing ends, is rejected or turns out to belong
to another host (`other_host`, which only a new pairing clears). A link
`lastError` of `key_rejected` or `certificate_mismatch` is a rejected
device, exactly like the same answer to an office call. A new revision
re-reads the signed-in user (`Office`, `hostRevision`); it does not reload an
open page, so a form keeps what was typed and a save over a newer record meets
`stale_revision`. Pages read fresh data whenever they open (`staleTime` 0).
```

Затем `node_modules/.bin/prettier --write` и `--check` на `AGENTS.md`.

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`; `git diff --check`.
Expected: всё зелёное.

```bash
git add apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/app.test.tsx apps/standalone/test/shell.test.ts apps/standalone/test/office.test.tsx apps/standalone/test/support/office.tsx apps/standalone/test/support/fixtures.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): связь с хостом и синхронизация в оболочке, другой хост, офис по ревизии" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Выбор линии и строка связи с хостом

Подключённая станция без линии сначала выбирает линию (спецификация, §5.1): выбор хранится в `device.json`, и станция открывается на своей линии даже без хоста. Это касается и рабочего места на ПК-хосте: оно подключено видом `station` и после мастера тоже выбирает линию, выйдя из офиса.

Линии берутся из локальных копий, но только после удачной синхронизации в этом сеансе. Иначе после повторного подключения к другому хосту экран на миг показал бы линии прежнего. Кнопка «Офис» остаётся: без линий на хосте в офис должно быть можно попасть.

Строка связи отвечает на отложенный пункт плана 1b3: спецификация (§5.1) велела офису показывать «нет связи с хостом» и блокировать действия. Блокирующего слоя нет: каждая страница офиса и так объясняет свою неудачную операцию и предлагает повторить, а строка в шапке показывает связь. Решение записывается в §5.1.

Тестовая фикстура `DEVICE_STATUS` получает линию: прежние тесты приложения и оболочки проверяют цех и офис станции, которая линию уже выбрала. Только что подключённая станция — новая фикстура `NEW_STATION`.

**Files:**

- Create: `apps/standalone/src/app/HostStatusLine.tsx`, `apps/standalone/src/app/LineSelect.tsx`, `apps/standalone/src/office/office-link.tsx`
- Create: `apps/standalone/test/host-status-line.test.tsx`, `apps/standalone/test/line-select.test.tsx`
- Modify: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/screens.tsx`, `apps/standalone/src/app/shell.css`
- Modify: `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/test/support/fixtures.ts`, `apps/standalone/test/app.test.tsx`, `apps/standalone/test/shell.test.ts`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.1)

**Interfaces:**

- Consumes:
  - из плана 1c2, задача 5: `DeviceApi.selectLine(lineId: string): Promise<DeviceStatus>`, коды `line_rejected`, `key_rejected`, `request_failed`; `LocalExecutor.query`;
  - задача 3: `SyncState`, `ShellState.link`, `useHostLink`, `Office`.
- Produces:
  - вид `{ kind: "line_select" }`, действие `{ type: "line_selected"; status: DeviceStatus }`;
  - `useHostLink(options: HostLinkOptions): () => void` — возвращает запуск синхронизации;
  - `HostStatusLine({ status }: { status: HostStatus | null })`;
  - `interface LineSelectProps { local: LocalExecutor; sync: SyncState; link: HostStatus | null; onSelect: (lineId: string) => Promise<void>; onSync: () => void; onOffice: () => void }`, `LineSelect(props: LineSelectProps)`;
  - `FloorScreen({ link, onOffice })`;
  - `OfficeProps.link?: HostStatus | null`, `OfficeLinkProvider`, `useOfficeLink(): HostStatus | null` (`src/office/office-link.tsx`);
  - в тестах: `DEVICE_STATUS.lineId = LINE_ID`, `NEW_STATION` (станция без линии).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/support/fixtures.ts` фрагмент

```ts
export const DEVICE_STATUS: DeviceStatus = {
  hostAddress: "https://127.0.0.1:45710",
  fingerprint: "ab".repeat(32),
  hostId: HOST_ID,
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  lineId: null,
};
```

заменить на

```ts
/** A station that already chose its line, so the app opens on the floor. */
export const DEVICE_STATUS: DeviceStatus = {
  hostAddress: "https://127.0.0.1:45710",
  fingerprint: "ab".repeat(32),
  hostId: HOST_ID,
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  lineId: LINE_ID,
};

/** A station just paired: it chooses its line first. */
export const NEW_STATION: DeviceStatus = { ...DEVICE_STATUS, lineId: null };
```

2. Create `apps/standalone/test/host-status-line.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostStatusLine } from "../src/app/HostStatusLine.js";
import { hostStatusSchema, type HostStatus } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";

/** 14:05 on this computer's clock, whatever its time zone. */
const AT_14_05 = new Date(2026, 8, 27, 14, 5).getTime();

function status(overrides: Partial<HostStatus>): HostStatus {
  return { state: "online", lastContactAt: AT_14_05, lastError: null, seq: 1, ...overrides };
}

describe("HostStatusLine", () => {
  it("says the host is online, politely for screen readers", () => {
    render(<HostStatusLine status={status({})} />);
    const line = screen.getByText("На связи с хостом").closest(".host-status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.getAttribute("role")).toBe("status");
  });

  it("says since when the host is silent and why", () => {
    render(<HostStatusLine status={status({ state: "offline", lastError: "unreachable" })} />);
    expect(screen.getByText("Нет связи с хостом с 14:05")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("says it is connecting and why the last attempt failed", () => {
    render(<HostStatusLine status={status({ state: "connecting", lastError: "stream_ended" })} />);
    expect(screen.getByText("Подключение к хосту…")).toBeTruthy();
    expect(screen.getByText("Связь с хостом прервалась.")).toBeTruthy();
  });

  it("says the host is silent when it never answered", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "key_rejected" })}
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

  it("shows nothing before the first status", () => {
    const { container } = render(<HostStatusLine status={null} />);
    expect(container.innerHTML).toBe("");
  });
});
```

3. Create `apps/standalone/test/line-select.test.tsx`:

```tsx
import type { DatabaseSync } from "node:sqlite";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("waits for a sync in this session before it reads the lines", () => {
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} />);
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull();
  });

  it("lists the active lines by name once the copies are up to date", async () => {
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 });
    insertLine(db, LINE_10, "Линия 10");
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, OLD_LINE, "Старая линия", 1);
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    await screen.findByRole("button", { name: "Линия 2" });
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((name) => name?.startsWith("Линия"));
    expect(names).toEqual(["Линия 2", "Линия 10"]);
    expect(screen.queryByRole("button", { name: "Старая линия" })).toBeNull();
  });

  it("explains a failed first sync and syncs again on request", () => {
    const { props } = renderLineSelect({ kind: "failed", synced: 0 });
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("says when the host has no active lines", async () => {
    renderLineSelect({ kind: "done", synced: 1 });
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });

  it("chooses a line with the host", async () => {
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(LINE_2));
  });

  it("explains a line the host refused, syncs and reads the lines again", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("line_rejected", "archived meanwhile");
    });
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 }, { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, LINE_10, "Линия 10");
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(
      await screen.findByText(
        "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      ),
    ).toBeTruthy();
    expect(props.onSync).toHaveBeenCalledTimes(1);

    // The sync brings the archive flag; the list follows it.
    db.prepare("UPDATE ref_lines SET archived = 1 WHERE id = ?").run(LINE_2);
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 2 }} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull());
    expect(screen.getByRole("button", { name: "Линия 10" })).toBeTruthy();
  });

  it("explains any other refusal without syncing", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("request_failed", "host error");
    });
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 }, { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(await screen.findByText("Хост не выполнил запрос. Повторите попытку.")).toBeTruthy();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it("shows the link and opens the office", () => {
    const { props } = renderLineSelect(
      { kind: "failed", synced: 0 },
      { link: { state: "offline", lastContactAt: null, lastError: "unreachable", seq: 4 } },
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(props.onOffice).toHaveBeenCalledTimes(1);
  });
});
```

4. В `apps/standalone/test/shell.test.ts`:

- фрагмент

```ts
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
```

заменить на

```ts
import { DEVICE_STATUS, NEW_STATION, observation, SESSION } from "./support/fixtures.js";
```

- фрагмент

```ts
  it("puts a rejected device before everything else", () => {
```

заменить на

```ts
  it("has a station without a line choose it, unless the office is open or opening", () => {
    const station = paired({ device: { kind: "ready", status: NEW_STATION } });
    expect(nextShellView(station, ADDRESS)).toEqual({ kind: "line_select" });
    expect(
      nextShellView({ ...station, office: { kind: "signing_in", notice: null } }, ADDRESS),
    ).toEqual({ kind: "office_login", notice: null });
    expect(
      nextShellView({ ...station, office: { kind: "open", session: SESSION } }, ADDRESS),
    ).toEqual({ kind: "office", session: SESSION });
    const office = paired({
      device: { kind: "ready", status: { ...NEW_STATION, kind: "office" } },
    });
    expect(nextShellView(office, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("puts a rejected device before everything else", () => {
```

- фрагмент

```ts
  it("retries a failed pairing", () => {
```

заменить на

```ts
  it("keeps the line the host confirmed", () => {
    const station = paired({ device: { kind: "ready", status: NEW_STATION } });
    const chosen = shellReducer(station, { type: "line_selected", status: DEVICE_STATUS });
    expect(chosen.device).toEqual({ kind: "ready", status: DEVICE_STATUS });
    expect(nextShellView(chosen, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("retries a failed pairing", () => {
```

5. В `apps/standalone/test/app.test.tsx`:

- фрагмент

```tsx
import { DEVICE_STATUS, HOST_ID, LINE_ID, observation, SESSION } from "./support/fixtures.js";
```

заменить на

```tsx
import {
  DEVICE_STATUS,
  HOST_ID,
  LINE_ID,
  NEW_STATION,
  observation,
  SESSION,
} from "./support/fixtures.js";
```

- в `fakeDevice` поддельный `selectLine` (из плана 1c2) заменить работающим — фрагмент

```tsx
    selectLine: vi.fn<DeviceApi["selectLine"]>(async () => {
      throw new Error("line selection is not part of the app yet");
    }),
```

заменить на

```tsx
    selectLine: vi.fn<DeviceApi["selectLine"]>(async (lineId) => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      paired = { ...paired, lineId };
      return paired;
    }),
```

- новые тесты в конец `describe("App")` — фрагмент

```tsx
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
  });
});
```

заменить на

```tsx
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
  });

  it("has a freshly paired station choose its line before the floor", async () => {
    const device = fakeDevice(null, NEW_STATION);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host });
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.selectLine).toHaveBeenCalledWith(LINE_ID);
  });

  it("sends a station whose key the host refuses while choosing a line to pairing again", async () => {
    const device = fakeDevice(NEW_STATION);
    device.selectLine.mockRejectedValueOnce(new DeviceError("key_rejected", "revoked"));
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("shows the link on the floor and in the office header", async () => {
    const link = fakeConnection();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("На связи с хостом")).toBeTruthy();
    link.status({ state: "offline", lastContactAt: null, lastError: "unreachable", seq: 2 });
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить тесты — новые падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/shell.test.ts test/app.test.tsx`
Expected: FAIL — `host-status-line.test.tsx` и `line-select.test.tsx` не загружаются (нет модулей), в `shell.test.ts` и `app.test.tsx` падают новые тесты: нет вида `line_select`, экрана выбора линии и строки связи.

- [ ] **Step 3: Экран выбора линии, строка связи и оболочка**

1. Create `apps/standalone/src/app/HostStatusLine.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { StatusChip, type TagPhase } from "@markiro/ui";

import type { HostStatus } from "../host/protocol.js";

const PHASE: Readonly<Record<HostStatus["state"], TagPhase>> = {
  online: "active",
  connecting: "running",
  offline: "attention",
};

/** Hours and minutes on this computer's clock. */
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/**
 * The link to the host, on the floor and in the office header: a tag that
 * says it in words, since when the host is silent, and why the last attempt
 * failed. Nothing before the shell's first status.
 */
export function HostStatusLine({ status }: { status: HostStatus | null }) {
  const { t } = useTranslation();
  if (status === null) return null;
  let label = t("link.online");
  if (status.state === "connecting") label = t("link.connecting");
  if (status.state === "offline") {
    label =
      status.lastContactAt === null
        ? t("link.offline")
        : t("link.offlineSince", { time: CLOCK.format(status.lastContactAt) });
  }
  return (
    <div className="host-status" role="status" aria-live="polite">
      <StatusChip phase={PHASE[status.state]} label={label} />
      {status.state !== "online" && status.lastError !== null && (
        <span className="host-status__reason">{t(`errors.link.${status.lastError}`)}</span>
      )}
    </div>
  );
}
```

2. Create `apps/standalone/src/app/LineSelect.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import { DeviceError, type DeviceErrorCode } from "../host/device.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { HostStatusLine } from "./HostStatusLine.js";
import type { SyncState } from "./shell.js";

const lineRow = z.object({ id: z.string(), name: z.string() });
type Line = z.infer<typeof lineRow>;

/** «Линия 2» before «Линия 10». */
const BY_NAME = new Intl.Collator("ru", { numeric: true });

export interface LineSelectProps {
  local: LocalExecutor;
  sync: SyncState;
  link: HostStatus | null;
  /** Chooses the line with the host; rejects with a `DeviceError` the screen explains. */
  onSelect: (lineId: string) => Promise<void>;
  /** Asks for a reference sync now. */
  onSync: () => void;
  onOffice: () => void;
}

/**
 * A paired station chooses its line (spec §5.1) among the active lines of
 * the local copies. They are read only once a sync in this session brought
 * them up to date, and again after every sync, so a previous pairing's lines
 * never show.
 */
export function LineSelect({ local, sync, link, onSelect, onSync, onOffice }: LineSelectProps) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [failure, setFailure] = useState<DeviceErrorCode | null>(null);

  useEffect(() => {
    if (sync.synced === 0) return;
    let cancelled = false;
    local.query("SELECT id, name FROM ref_lines WHERE archived = 0", [], lineRow).then(
      (rows) => {
        if (cancelled) return;
        setLines([...rows].sort((a, b) => BY_NAME.compare(a.name, b.name)));
        setReadFailed(false);
      },
      () => {
        if (!cancelled) setReadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, sync.synced]);

  const choose = async (lineId: string) => {
    setChoosing(lineId);
    setFailure(null);
    try {
      // On success the shell leaves this screen.
      await onSelect(lineId);
    } catch (error) {
      const code = error instanceof DeviceError ? error.code : "request_failed";
      setFailure(code);
      setChoosing(null);
      // The line was archived or deleted meanwhile: sync, then read the lines again.
      if (code === "line_rejected") onSync();
    }
  };

  const content = () => {
    if (lines === null) {
      if (sync.kind === "failed" || readFailed) {
        return (
          <Alert
            tone="error"
            action={
              <Button variant="secondary" size="compact" onClick={onSync}>
                {t("shell.lineSelect.retry")}
              </Button>
            }
          >
            {t("shell.lineSelect.syncFailed")}
          </Alert>
        );
      }
      return (
        <div className="standalone-probing">
          <Spinner size={32} />
          <p>{t("shell.lineSelect.loading")}</p>
        </div>
      );
    }
    if (lines.length === 0) return <p>{t("shell.lineSelect.empty")}</p>;
    return (
      <div className="line-select">
        {lines.map((line) => (
          <Button
            key={line.id}
            variant="secondary"
            size="floor"
            fullWidth
            loading={choosing === line.id}
            disabled={choosing !== null && choosing !== line.id}
            onClick={() => void choose(line.id)}
          >
            {line.name}
          </Button>
        ))}
      </div>
    );
  };

  return (
    <Card className="standalone-card" title={t("shell.lineSelect.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("shell.lineSelect.body")}</p>
        {failure && <Alert tone="error">{t(`errors.device.${failure}`)}</Alert>}
        {content()}
        <HostStatusLine status={link} />
        <div className="standalone-form__actions">
          <Button variant="secondary" onClick={onOffice}>
            {t("floor.office")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

3. Create `apps/standalone/src/office/office-link.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { HostStatus } from "../host/protocol.js";

const OfficeLinkContext = createContext<HostStatus | null>(null);

/** The link to the host as the shell reports it, for the office header. */
export function OfficeLinkProvider({
  value,
  children,
}: {
  value: HostStatus | null;
  children: ReactNode;
}) {
  return <OfficeLinkContext.Provider value={value}>{children}</OfficeLinkContext.Provider>;
}

/** `null` before the shell's first status and outside the office. */
export function useOfficeLink(): HostStatus | null {
  return useContext(OfficeLinkContext);
}
```

4. В `apps/standalone/src/app/shell.ts`:

- фрагмент

```ts
  | { kind: "other_host"; hostAddress: string }
  | { kind: "floor" }
```

заменить на

```ts
  | { kind: "other_host"; hostAddress: string }
  | { kind: "line_select" }
  | { kind: "floor" }
```

- фрагмент

```ts
  | { type: "sync_failed" };
```

заменить на

```ts
  | { type: "sync_failed" }
  | { type: "line_selected"; status: DeviceStatus };
```

- в `nextShellView` фрагмент

```ts
  switch (state.office.kind) {
    case "closed":
      return { kind: "floor" };
```

заменить на

```ts
  switch (state.office.kind) {
    case "closed":
      // A station works on one line and chooses it before the floor.
      if (status.kind === "station" && status.lineId === null) return { kind: "line_select" };
      return { kind: "floor" };
```

- в `shellReducer` фрагмент

```ts
    case "sync_failed":
      return { ...state, sync: { ...state.sync, kind: "failed" } };
  }
}
```

заменить на

```ts
    case "sync_failed":
      return { ...state, sync: { ...state.sync, kind: "failed" } };
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status } };
  }
}
```

5. В `apps/standalone/src/app/host-link.ts`:

- фрагмент

```ts
import { useEffect } from "react";
```

заменить на

```ts
import { useCallback, useEffect, useRef } from "react";
```

- фрагмент

```ts
 * revision, so catching up needs nothing more.
 */
```

заменить на

```ts
 * revision, so catching up needs nothing more. Returns a function that asks
 * for a sync now.
 */
```

- фрагмент

```ts
}: HostLinkOptions): void {
  useEffect(() => {
```

заменить на

```ts
}: HostLinkOptions): () => void {
  const syncNow = useRef<() => void>(() => undefined);
  useEffect(() => {
```

- фрагмент

<!-- prettier-ignore -->
```ts
    let unwatch: (() => void) | null = null;
```

заменить на

<!-- prettier-ignore -->
```ts
    syncNow.current = scheduler.trigger;
    let unwatch: (() => void) | null = null;
```

- фрагмент

```ts
      active = false;
      scheduler.stop();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, dispatch]);
}
```

заменить на

```ts
      active = false;
      syncNow.current = () => undefined;
      scheduler.stop();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
```

6. В `apps/standalone/src/app/screens.tsx`:

- фрагмент

```tsx
import type { HostProbeErrorCode } from "../host/probe.js";
import type { RejectionReason } from "./shell.js";
```

заменить на

```tsx
import type { HostProbeErrorCode } from "../host/probe.js";
import type { HostStatus } from "../host/protocol.js";
import { HostStatusLine } from "./HostStatusLine.js";
import type { RejectionReason } from "./shell.js";
```

- фрагмент

```tsx
/** The floor placeholder until plan 1f: the way into the office. */
export function FloorScreen({ onOffice }: { onOffice: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <p>{t("floor.body")}</p>
      <Button onClick={onOffice}>{t("floor.office")}</Button>
    </Card>
  );
}
```

заменить на

```tsx
/** The floor placeholder until plan 1f: the link to the host and the way into the office. */
export function FloorScreen({ link, onOffice }: { link: HostStatus | null; onOffice: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("floor.body")}</p>
        <HostStatusLine status={link} />
        <div className="standalone-form__actions">
          <Button onClick={onOffice}>{t("floor.office")}</Button>
        </div>
      </div>
    </Card>
  );
}
```

7. В `apps/standalone/src/app/App.tsx`:

- фрагмент

```tsx
import { useHostLink } from "./host-link.js";
```

заменить на

```tsx
import { useHostLink } from "./host-link.js";
import { LineSelect } from "./LineSelect.js";
```

- фрагмент

```tsx
  useHostLink({
```

заменить на

```tsx
  const requestSync = useHostLink({
```

- фрагмент

```tsx
  const retryProbe = useCallback(() => {
```

заменить на

```tsx
  const selectLine = useCallback(
    async (lineId: string) => {
      try {
        dispatch({ type: "line_selected", status: await deviceApi.selectLine(lineId) });
      } catch (error) {
        if (error instanceof DeviceError && error.code === "key_rejected") {
          dispatch({ type: "device_rejected", reason: "key_rejected" });
          return;
        }
        throw error;
      }
    },
    [deviceApi],
  );

  const retryProbe = useCallback(() => {
```

- фрагмент

<!-- prettier-ignore -->
```tsx
    return <Office key={session.token} session={officeSession} hostRevision={state.hostRevision} />;
```

заменить на

<!-- prettier-ignore -->
```tsx
    return (
      <Office
        key={session.token}
        session={officeSession}
        link={state.link}
        hostRevision={state.hostRevision}
      />
    );
```

- фрагмент

<!-- prettier-ignore -->
```tsx
      {view.kind === "floor" && (
        <FloorScreen onOffice={() => dispatch({ type: "office_requested" })} />
      )}
```

заменить на

<!-- prettier-ignore -->
```tsx
      {view.kind === "line_select" && (
        <LineSelect
          local={localDb}
          sync={state.sync}
          link={state.link}
          onSelect={selectLine}
          onSync={requestSync}
          onOffice={() => dispatch({ type: "office_requested" })}
        />
      )}
      {view.kind === "floor" && (
        <FloorScreen link={state.link} onOffice={() => dispatch({ type: "office_requested" })} />
      )}
```

8. В `apps/standalone/src/app/shell.css` фрагмент

```css
.standalone-fingerprint-label {
```

заменить на

```css
.line-select {
  display: grid;
  gap: 8px;
}

.host-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.host-status__reason {
  color: var(--fg-2);
}

.standalone-fingerprint-label {
```

9. В `apps/standalone/src/office/Office.tsx`:

- фрагмент

```tsx
import { createOfficeQueryClient } from "./office-query.js";
```

заменить на

```tsx
import type { HostStatus } from "../host/protocol.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
```

- фрагмент

```tsx
export interface OfficeProps {
  session: OfficeSessionValue;
```

заменить на

```tsx
export interface OfficeProps {
  session: OfficeSessionValue;
  /** The link to the host, shown in the header; `null` before the first status. */
  link?: HostStatus | null;
```

- фрагмент

```tsx
export function Office({ session, hostRevision = null }: OfficeProps) {
```

заменить на

```tsx
export function Office({ session, link = null, hostRevision = null }: OfficeProps) {
```

- фрагмент

<!-- prettier-ignore -->
```tsx
        <RouterProvider router={router} />
```

заменить на

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={link}>
          <RouterProvider router={router} />
        </OfficeLinkProvider>
```

10. В `apps/standalone/src/office/OfficeShell.tsx`:

- фрагмент

```tsx
import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
import { OFFICE_NAV } from "./nav.js";
import { useOfficeSession } from "./office-session.js";
```

заменить на

```tsx
import { HostStatusLine } from "../app/HostStatusLine.js";
import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
import { OFFICE_NAV } from "./nav.js";
import { useOfficeLink } from "./office-link.js";
import { useOfficeSession } from "./office-session.js";
```

- фрагмент

<!-- prettier-ignore -->
```tsx
  const session = useOfficeSession();
  const { theme, setTheme } = useTheme();
```

заменить на

<!-- prettier-ignore -->
```tsx
  const session = useOfficeSession();
  const link = useOfficeLink();
  const { theme, setTheme } = useTheme();
```

- фрагмент

```tsx
            <span className="office-header__role">{t(`office.roles.${session.user.role}`)}</span>
          </div>
```

заменить на

```tsx
            <span className="office-header__role">{t(`office.roles.${session.user.role}`)}</span>
          </div>
          <HostStatusLine status={link} />
```

11. В `apps/standalone/src/i18n/ru.json`:

- фрагмент

```json
    "otherHost": {
```

заменить на

```json
    "lineSelect": {
      "title": "Выбор линии",
      "body": "Выберите линию, на которой работает эта станция.",
      "loading": "Получаем справочники с хоста…",
      "syncFailed": "Не удалось получить справочники с хоста.",
      "retry": "Повторить",
      "empty": "На хосте нет активных линий."
    },
    "otherHost": {
```

- фрагмент

```json
  "floor": {
```

заменить на

```json
  "link": {
    "online": "На связи с хостом",
    "connecting": "Подключение к хосту…",
    "offline": "Нет связи с хостом",
    "offlineSince": "Нет связи с хостом с {{time}}"
  },
  "floor": {
```

- фрагмент

```json
    "unknown": "Что-то пошло не так. Повторите попытку.",
```

заменить на

```json
    "unknown": "Что-то пошло не так. Повторите попытку.",
    "link": {
      "unreachable": "Хост не отвечает.",
      "certificate_mismatch": "Сертификат хоста не совпадает с сохранённым при подключении.",
      "key_rejected": "Хост не принимает это устройство.",
      "stream_refused": "Хост отказал в потоке изменений.",
      "stream_ended": "Связь с хостом прервалась."
    },
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/shell.test.ts test/app.test.tsx`
Expected: PASS — 6 тестов в `host-status-line.test.tsx`, 8 в `line-select.test.tsx`, 31 в `shell.test.ts`, 31 в `app.test.tsx`.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` в конец раздела «App shell» добавить абзац:

```text
A paired station without a line chooses one (`LineSelect`) among the active
lines of the local copies, read only after a sync in this session brought
them up to date and again after every sync, so a previous pairing's lines
never show; the host's answer goes to `device.json` through
`device_select_line`. `HostStatusLine` shows the link on the floor, on the
line screen and in the office header — online, connecting, or silent since
the last contact, with the reason — as a phase tag with words in a polite
live region. There is no blocking overlay while the host is away: office
pages explain their own failed requests and offer a retry.
```

2. В спецификации, §5.1, фрагмент

```text
Если хост недоступен, офис
показывает состояние «нет связи с хостом» и блокирует действия; цех работает.
```

(перенос строки в файле может стоять в другом месте) заменить на

```text
Если хост недоступен, строка связи
в шапке офиса показывает «нет связи с хостом» и время последней связи, а каждый
экран офиса объясняет свою неудачную операцию и предлагает повторить; отдельного
блокирующего слоя нет. Цех работает, строка связи есть и там.
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`; `git diff --check`.
Expected: всё зелёное.

```bash
git add apps/standalone/src/app/HostStatusLine.tsx apps/standalone/src/app/LineSelect.tsx apps/standalone/src/office/office-link.tsx apps/standalone/test/host-status-line.test.tsx apps/standalone/test/line-select.test.tsx apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/app/shell.css apps/standalone/src/office/Office.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/fixtures.ts apps/standalone/test/app.test.tsx apps/standalone/test/shell.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): выбор линии станцией и строка связи с хостом" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Подключение к хосту в сети — `src/app/NetworkPairing.tsx`

Второй ПК подключается к хосту в сети одноразовым кодом из офиса (спецификация, §4.7). На экране «хост не найден» у неподключённого устройства появляется кнопка «Подключиться к хосту в сети». Путей два.

Сканирование. Поле кода получает фокус при открытии экрана; клавиатурный сканер набирает машиночитаемый код и Enter. Все адреса из кода опрашиваются одновременно: мёртвый адрес стоит таймаута соединения, а виртуальные адаптеры (Hyper-V, WSL) стоят в списке первыми. Код уходит на первый адрес, чей сертификат совпал с отпечатком из кода. Человека не спрашивают: код пришёл с экрана офиса.

Ручной ввод. Человек вводит адрес и код. Экран запрашивает `hello` и показывает отпечаток хоста. Код уходит, только когда человек подтвердил, что отпечаток совпадает с экраном офиса.

Код не того вида не уходит никуда. Отказ хоста не повторяется сам: код, погашенный чужими неверными попытками, выглядит как `pairing_code_invalid`, и его текст уже велит получить новый код.

Тексты `errors.device.unreachable` и `errors.device.not_markiro_host` говорят «на этом компьютере»: они написаны для местного хоста. Для хоста в сети экран берёт свои тексты; отказы хоста показываются текстами `errors.device.<код>`, как решено.

**Files:**

- Create: `apps/standalone/src/app/host-search.ts`, `apps/standalone/src/app/NetworkPairing.tsx`
- Create: `apps/standalone/test/host-search.test.ts`, `apps/standalone/test/network-pairing.test.tsx`
- Modify: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/screens.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/test/app.test.tsx`, `apps/standalone/test/shell.test.ts`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§4.7, §5.1)

**Interfaces:**

- Consumes:
  - из плана 1c2, задача 5: `DeviceApi.claim(input: ClaimInput): Promise<DeviceStatus>`, `ClaimInput { address: string; fingerprint: string; code: string; name: string }`, коды `pairing_code_invalid`, `pairing_code_expired`, `rate_limited`;
  - задача 2: `normalizePairingCode`, `parsePairingPayload`;
  - `HostProbe.hello(address: string): Promise<HelloObservation>`, `HostProbeError` (`src/host/probe.ts`), `formatFingerprint(hex: string): string` (`src/app/fingerprint.ts`), `personNameRule` (`src/lib/rules.ts`), `errorProp` (`src/lib/form-error.ts`), `DEFAULT_HOST_PORT` (`src/host/protocol.ts`).
- Produces:
  - `PairingState` получает `{ kind: "network" }`; действия `{ type: "network_pairing_requested" }` и `{ type: "network_pairing_cancelled" }`; вид `{ kind: "network_pairing" }`;
  - `hostUrl(host: string, port: number): string`, `parseHostAddress(input: string): string | null`;
  - `type HostSearch = { kind: "found"; address: string } | { kind: "other_host" } | { kind: "incompatible"; reason: "host_too_old" | "app_too_old" } | { kind: "unreachable" }`;
  - `findHost(probe: HostProbe, candidates: readonly string[], fingerprint: string): Promise<HostSearch>`;
  - `interface NetworkPairingProps { probe: HostProbe; onClaim: (input: ClaimInput) => Promise<void>; onBack: () => void }`, `NetworkPairing(props: NetworkPairingProps)`;
  - у `HostMissingScreen` новое свойство `onNetwork: (() => void) | null`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/host-search.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { findHost, parseHostAddress } from "../src/app/host-search.js";
import { HostProbeError, type HelloObservation, type HostProbe } from "../src/host/probe.js";
import { observation } from "./support/fixtures.js";

const FINGERPRINT = "ab".repeat(32);
const VIRTUAL = "https://172.20.0.1:45710";
const LAN = "https://192.168.1.10:45710";

function seen(fingerprint: string): HelloObservation {
  return { ...observation(true), fingerprint };
}

describe("parseHostAddress", () => {
  it.each([
    ["192.168.1.10", "https://192.168.1.10:45710"],
    [" 192.168.1.10:8443 ", "https://192.168.1.10:8443"],
    ["host-pc", "https://host-pc:45710"],
    ["host-pc.local:45710", "https://host-pc.local:45710"],
  ])("reads %j", (input, url) => {
    expect(parseHostAddress(input)).toBe(url);
  });

  it.each([
    "",
    "https://192.168.1.10",
    "192.168.1.10:0",
    "192.168.1.10:65536",
    "192.168.1.10:port",
    "192.168.1.10 45710",
    "-host",
    "host_pc",
  ])("refuses %j", (input) => {
    expect(parseHostAddress(input)).toBeNull();
  });
});

describe("findHost", () => {
  it("probes every address at once and takes the one with the code's certificate", async () => {
    const hello = vi.fn<HostProbe["hello"]>((address) =>
      // A virtual adapter that never answers must not hold up the real one.
      address === VIRTUAL
        ? new Promise<HelloObservation>(() => undefined)
        : Promise.resolve(seen(FINGERPRINT)),
    );
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "found",
      address: LAN,
    });
    expect(hello.mock.calls).toEqual([[VIRTUAL], [LAN]]);
  });

  it("does not trust a host with another certificate", async () => {
    const hello = vi.fn<HostProbe["hello"]>(async () => seen("cd".repeat(32)));
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "other_host",
    });
  });

  it("prefers a version to update over a foreign or a dead host", async () => {
    const hello = vi.fn<HostProbe["hello"]>(async (address) => {
      if (address === VIRTUAL) throw new HostProbeError("unreachable", "down");
      throw new HostProbeError("app_too_old", "old");
    });
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "incompatible",
      reason: "app_too_old",
    });
  });

  it("finds nothing when no address answers, or there is none", async () => {
    const hello = vi.fn<HostProbe["hello"]>(async () => {
      throw new HostProbeError("unreachable", "down");
    });
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "unreachable",
    });
    await expect(findHost({ hello }, [], FINGERPRINT)).resolves.toEqual({ kind: "unreachable" });
  });
});
```

2. Create `apps/standalone/test/network-pairing.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NetworkPairing, type NetworkPairingProps } from "../src/app/NetworkPairing.js";
import { DeviceError } from "../src/host/device.js";
import { HostProbeError, type HelloObservation, type HostProbe } from "../src/host/probe.js";
import { observation } from "./support/fixtures.js";

const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=172.20.0.1,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;
/** `PAYLOAD` typed by a keyboard-wedge scanner while the Russian layout is on. */
const PAYLOAD_IN_RUSSIAN =
  "ьфклшкщ-рщыеЖ1,р=172ю20ю0ю1б192ю168ю1ю10?з=45710?а=" + "фи".repeat(32) + "?с=7Л3ЬЙ9ЧМ2В";

function seen(fingerprint: string): HelloObservation {
  return { ...observation(true), fingerprint };
}

/** Only 192.168.1.10 answers, with the certificate of the payload. */
function lanProbe() {
  return {
    hello: vi.fn<HostProbe["hello"]>(async (address) => {
      if (address !== "https://192.168.1.10:45710") throw new HostProbeError("unreachable", "down");
      return seen(FINGERPRINT);
    }),
  };
}

function renderPairing(overrides: Partial<NetworkPairingProps> = {}) {
  const props: NetworkPairingProps = {
    probe: lanProbe(),
    onClaim: vi.fn<NetworkPairingProps["onClaim"]>(async () => undefined),
    onBack: vi.fn<NetworkPairingProps["onBack"]>(),
    ...overrides,
  };
  render(<NetworkPairing {...props} />);
  return props;
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function scan(text: string): void {
  type("Код с экрана офиса", text);
  fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
}

describe("NetworkPairing", () => {
  it("waits for the scanner in a focused field", () => {
    renderPairing();
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("pairs with a scanned code: every address at once, the code's certificate, no question", async () => {
    const props = renderPairing();
    scan(PAYLOAD);
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция",
      }),
    );
    expect(props.probe.hello).toHaveBeenCalledWith("https://172.20.0.1:45710");
    expect(props.probe.hello).toHaveBeenCalledWith("https://192.168.1.10:45710");
    expect(screen.getByLabelText("Код с экрана офиса")).toHaveProperty("value", "");
  });

  it("reads a code the scanner typed under the Russian layout", async () => {
    const props = renderPairing();
    type("Имя устройства", "  Станция на линии 2 ");
    scan(PAYLOAD_IN_RUSSIAN);
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция на линии 2",
      }),
    );
  });

  it("explains a scan that is not a pairing code, without probing", async () => {
    const props = renderPairing();
    scan("4600682000013");
    expect(
      await screen.findByText("Это не код подключения Markiro. Отсканируйте код с экрана офиса."),
    ).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("warns when the code carries no host address", async () => {
    const props = renderPairing();
    scan(PAYLOAD.replace("172.20.0.1,192.168.1.10", ""));
    expect(
      await screen.findByText(
        "В коде нет адреса хоста: у ПК-хоста нет адреса в локальной сети. Проверьте его сеть или введите адрес вручную.",
      ),
    ).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("names the addresses when none answers with the code's certificate", async () => {
    const probe = {
      hello: vi.fn<HostProbe["hello"]>(async () => {
        throw new HostProbeError("unreachable", "down");
      }),
    };
    const props = renderPairing({ probe });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "Хост из кода не отвечает ни по одному адресу (172.20.0.1, 192.168.1.10). Проверьте, что ПК-хост включён и в той же сети.",
      ),
    ).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("keeps the code from a host with another certificate", async () => {
    const probe = { hello: vi.fn<HostProbe["hello"]>(async () => seen("cd".repeat(32))) };
    const props = renderPairing({ probe });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "По адресу из кода отвечает другой хост: отпечаток не совпадает. Код не отправлен.",
      ),
    ).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("explains a refused code and never sends it again on its own", async () => {
    const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
      throw new DeviceError("pairing_code_invalid", "refused");
    });
    renderPairing({ onClaim });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      ),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it("asks for a new code when the host may already have taken this one", async () => {
    const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
      throw new DeviceError("storage", "could not save the pairing");
    });
    renderPairing({ onClaim });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова.",
      ),
    ).toBeTruthy();
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it("asks for a device name before anything reaches the network", async () => {
    const props = renderPairing();
    type("Имя устройства", "   ");
    scan(PAYLOAD);
    expect(await screen.findByText("Укажите имя, до 100 символов")).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("pairs by hand after a person confirms the host's fingerprint", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7k3mq-9xv2d");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Отпечаток хоста https://192.168.1.10:45710")).toBeTruthy();
    expect(screen.getByText("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB")).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отпечаток совпадает" }));
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция",
      }),
    );
  });

  it("goes back without the code when the fingerprint differs", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(await screen.findByRole("button", { name: "Не совпадает" }));
    expect(
      await screen.findByText("Отпечаток не совпал, код не отправлен. Проверьте адрес хоста."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Адрес хоста")).toHaveProperty("value", "192.168.1.10");
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("checks the typed code and address before asking the host anything", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "https://192.168.1.10");
    type("Код подключения", "12345");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Проверьте код: 10 символов")).toBeTruthy();
    expect(screen.getByText("Укажите адрес: 192.168.1.10 или 192.168.1.10:45710")).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("explains a host that does not answer in network words", async () => {
    renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.20");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(
      await screen.findByText(
        "Хост не отвечает по этому адресу. Проверьте адрес и что ПК-хост включён.",
      ),
    ).toBeTruthy();
  });

  it("goes back", () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
```

3. В `apps/standalone/test/shell.test.ts` фрагмент

```ts
  it("finishes the wizard for a paired device whose local host is not initialized", () => {
```

заменить на

```ts
  it("pairs in the network when asked, whatever the local host says", () => {
    const network = shellReducer(
      unpaired({ localHost: { kind: "missing", reason: "unreachable" } }),
      { type: "network_pairing_requested" },
    );
    expect(nextShellView(network, ADDRESS)).toEqual({ kind: "network_pairing" });
    expect(nextShellView({ ...network, localHost: { kind: "probing" } }, ADDRESS)).toEqual({
      kind: "network_pairing",
    });
    const back = shellReducer(network, { type: "network_pairing_cancelled" });
    expect(nextShellView(back, ADDRESS)).toEqual({ kind: "host_missing", reason: "unreachable" });
    const claimed = shellReducer(network, { type: "paired", status: NEW_STATION });
    expect(claimed.pairing).toEqual({ kind: "idle" });
  });

  it("finishes the wizard for a paired device whose local host is not initialized", () => {
```

4. В `apps/standalone/test/app.test.tsx`:

- в `fakeDevice` поддельный `claim` (из плана 1c2) заменить работающим — фрагмент

```tsx
    claim: vi.fn<DeviceApi["claim"]>(async () => {
      throw new Error("pairing by code is not part of the app yet");
    }),
```

заменить на

```tsx
    claim: vi.fn<DeviceApi["claim"]>(async ({ address, fingerprint }) => {
      if (paired) throw new DeviceError("already_paired", "already paired");
      paired = { ...NEW_STATION, hostAddress: address, fingerprint };
      return paired;
    }),
```

- новые тесты в конец `describe("App")` — фрагмент

```tsx
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
  });
});
```

заменить на

```tsx
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
  });

  it("pairs a second computer by a scanned code, then chooses its line", async () => {
    const payload = `markiro-host:1?h=192.168.1.10&p=45710&f=${"ab".repeat(32)}&c=7K3MQ9XV2D`;
    const probe = {
      hello: vi.fn<HostProbe["hello"]>(async (address) => {
        if (address !== REMOTE_ADDRESS) throw new HostProbeError("unreachable", "no host here");
        return observation(true);
      }),
    };
    const device = fakeDevice(null);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe, device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Подключиться к хосту в сети" }));
    fireEvent.change(await screen.findByLabelText("Код с экрана офиса"), {
      target: { value: payload },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.claim).toHaveBeenCalledWith({
      address: REMOTE_ADDRESS,
      fingerprint: "ab".repeat(32),
      code: "7K3MQ9XV2D",
      name: "Станция",
    });
    expect(device.pairLocally).not.toHaveBeenCalled();
    expect(host.getChanges).toHaveBeenCalledWith(0);
  });

  it("goes back from pairing in the network to the missing local host", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("unreachable", "down")),
      device: fakeDevice(null),
      host: fakeHost(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Подключиться к хосту в сети" }));
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    expect(await screen.findByText("Служба хоста не отвечает")).toBeTruthy();
  });

  it("offers pairing in the network only to a device that is not paired", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("app_too_old", "old")),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
    });
    await screen.findByText("Версии не совпадают");
    expect(screen.queryByRole("button", { name: "Подключиться к хосту в сети" })).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тесты — новые падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-search.test.ts test/network-pairing.test.tsx test/shell.test.ts test/app.test.tsx`
Expected: FAIL — `host-search.test.ts` и `network-pairing.test.tsx` не загружаются (нет модулей); падают новый тест `shell.test.ts` и два из трёх новых тестов `app.test.tsx`: нет вида `network_pairing` и кнопки «Подключиться к хосту в сети». Третий новый тест приложения — что у подключённого устройства этой кнопки нет — проходит уже сейчас.

- [ ] **Step 3: Поиск хоста, экран подключения и оболочка**

1. Create `apps/standalone/src/app/host-search.ts`:

```ts
import { HostProbeError, type HostProbe } from "../host/probe.js";
import { DEFAULT_HOST_PORT } from "../host/protocol.js";

/** The URL the shell calls for a host at `host` (an address or a name) and `port`. */
export function hostUrl(host: string, port: number): string {
  return `https://${host}:${port}`;
}

/** An IPv4 address or a host name: letters, digits, dots and inner hyphens. */
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * A host address a person typed — `host` or `host:port`, port 45710 when
 * left out — as the URL the shell calls; `null` when it is neither.
 */
export function parseHostAddress(input: string): string | null {
  const match = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(input.trim());
  if (match === null) return null;
  const [, host = "", port] = match;
  const number = port === undefined ? DEFAULT_HOST_PORT : Number(port);
  if (!HOST_NAME.test(host) || number < 1 || number > 65535) return null;
  return hostUrl(host, number);
}

/** Where the host of a pairing payload answered, or the most telling reason it did not. */
export type HostSearch =
  | { kind: "found"; address: string }
  /** A Markiro host answered, but with another certificate than the payload's. */
  | { kind: "other_host" }
  | { kind: "incompatible"; reason: "host_too_old" | "app_too_old" }
  | { kind: "unreachable" };

type Failure = Exclude<HostSearch, { kind: "found" }>;

/** Which failure explains the search best: a version to update, then a foreign host. */
const TELLING: readonly Failure["kind"][] = ["incompatible", "other_host", "unreachable"];

/**
 * Probes every candidate at once and settles on the first whose certificate
 * has `fingerprint`. Probing one by one would cost a connect timeout for
 * every dead address first, and virtual adapters sort before the real one.
 */
export function findHost(
  probe: HostProbe,
  candidates: readonly string[],
  fingerprint: string,
): Promise<HostSearch> {
  return new Promise((resolve) => {
    const failures: Failure[] = [];
    const fail = (failure: Failure) => {
      failures.push(failure);
      if (failures.length < candidates.length) return;
      const telling = TELLING.map((kind) => failures.find((each) => each.kind === kind));
      resolve(telling.find((each) => each !== undefined) ?? { kind: "unreachable" });
    };
    if (candidates.length === 0) resolve({ kind: "unreachable" });
    for (const address of candidates) {
      probe.hello(address).then(
        (observation) => {
          if (observation.fingerprint === fingerprint) resolve({ kind: "found", address });
          else fail({ kind: "other_host" });
        },
        (error: unknown) => {
          const code = error instanceof HostProbeError ? error.code : "unreachable";
          fail(
            code === "host_too_old" || code === "app_too_old"
              ? { kind: "incompatible", reason: code }
              : { kind: "unreachable" },
          );
        },
      );
    }
  });
}
```

2. Create `apps/standalone/src/app/NetworkPairing.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input } from "@markiro/ui";

import { DeviceError, type ClaimInput, type DeviceErrorCode } from "../host/device.js";
import { normalizePairingCode, parsePairingPayload } from "../host/pairing-code.js";
import { HostProbeError, type HostProbe } from "../host/probe.js";
import { errorProp } from "../lib/form-error.js";
import { personNameRule } from "../lib/rules.js";
import { formatFingerprint } from "./fingerprint.js";
import { findHost, hostUrl, parseHostAddress, type HostSearch } from "./host-search.js";

export interface NetworkPairingProps {
  probe: HostProbe;
  /** Pairs with the confirmed host; rejects with a `DeviceError` the screen explains. */
  onClaim: (input: ClaimInput) => Promise<void>;
  onBack: () => void;
}

/** A typed code waiting for a person to compare the host's fingerprint with the office screen. */
interface Confirmation {
  address: string;
  fingerprint: string;
  code: string;
  name: string;
}

/** An i18n key with its values. */
interface Notice {
  key: string;
  values?: Record<string, string>;
}

/** The device texts that speak of "this computer" get network words here. */
function failureKey(error: unknown): string {
  let code: DeviceErrorCode | null = null;
  if (error instanceof DeviceError || error instanceof HostProbeError) code = error.code;
  if (code === "unreachable") return "shell.networkPairing.errors.unreachable";
  if (code === "not_markiro_host") return "shell.networkPairing.errors.notHost";
  return code === null ? "errors.unknown" : `errors.device.${code}`;
}

/**
 * Failures that can come after the host already took the code (its answer
 * was unreadable, came from another host, or could not be saved here): the
 * code may be spent, so the text asks for a new one instead of a retry.
 */
const MAYBE_SPENT: ReadonlySet<DeviceErrorCode> = new Set([
  "invalid_response",
  "host_changed",
  "storage",
]);

function claimFailureKey(error: unknown): string {
  if (error instanceof DeviceError && MAYBE_SPENT.has(error.code)) {
    return "shell.networkPairing.errors.codeMaybeSpent";
  }
  return failureKey(error);
}

function searchNotice(search: Exclude<HostSearch, { kind: "found" }>, addresses: string): Notice {
  switch (search.kind) {
    case "other_host":
      return { key: "shell.networkPairing.errors.otherHost" };
    case "incompatible":
      return { key: `errors.device.${search.reason}` };
    case "unreachable":
      return { key: "shell.networkPairing.errors.notFound", values: { addresses } };
  }
}

/**
 * Pairing with a host in the network (spec §4.7). A scanned office code
 * carries the host's addresses and certificate fingerprint: every address is
 * probed at once, and the code goes out only to the one whose certificate
 * matches. A typed address and code show the host's fingerprint first; the
 * code goes out only after a person confirmed it against the office screen.
 * A refused claim is never retried on its own.
 */
export function NetworkPairing({ probe, onClaim, onBack }: NetworkPairingProps) {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const [name, setName] = useState(() => t("shell.networkPairing.defaultName"));
  const [nameInvalid, setNameInvalid] = useState(false);
  const [scan, setScan] = useState("");
  const [address, setAddress] = useState("");
  const [addressInvalid, setAddressInvalid] = useState(false);
  const [code, setCode] = useState("");
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const checkedName = (): string | null => {
    const parsed = personNameRule.safeParse(name);
    setNameInvalid(!parsed.success);
    return parsed.success ? parsed.data : null;
  };

  const claim = async (input: ClaimInput) => {
    try {
      // On success the shell leaves this screen.
      await onClaim(input);
    } catch (error) {
      setConfirmation(null);
      setNotice({ key: claimFailureKey(error) });
      setBusy(false);
    }
  };

  const submitScan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const text = scan;
    // A scan is read once: the next one starts in an empty field.
    setScan("");
    setNotice(null);
    const deviceName = checkedName();
    const payload = parsePairingPayload(text);
    if (payload === null) {
      setNotice({ key: "shell.networkPairing.errors.notPayload" });
      return;
    }
    if (payload.addresses.length === 0) {
      setNotice({ key: "shell.networkPairing.errors.noAddresses" });
      return;
    }
    if (deviceName === null) return;
    setBusy(true);
    const candidates = payload.addresses.map((host) => hostUrl(host, payload.port));
    const search = await findHost(probe, candidates, payload.fingerprint);
    if (search.kind !== "found") {
      setNotice(searchNotice(search, payload.addresses.join(", ")));
      setBusy(false);
      return;
    }
    await claim({
      address: search.address,
      fingerprint: payload.fingerprint,
      code: payload.code,
      name: deviceName,
    });
  };

  const submitManual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const deviceName = checkedName();
    const url = parseHostAddress(address);
    // A code that cannot be a code never reaches the host, where a wrong one
    // counts against every live code.
    const canonical = normalizePairingCode(code);
    setAddressInvalid(url === null);
    setCodeInvalid(canonical === null);
    if (deviceName === null || url === null || canonical === null) return;
    setBusy(true);
    try {
      const observation = await probe.hello(url);
      setConfirmation({
        address: url,
        fingerprint: observation.fingerprint,
        code: canonical,
        name: deviceName,
      });
    } catch (error) {
      setNotice({ key: failureKey(error) });
    }
    setBusy(false);
  };

  const confirm = async (confirmed: Confirmation) => {
    setBusy(true);
    setNotice(null);
    await claim(confirmed);
  };

  const nameField = (
    <Input
      label={t("shell.networkPairing.name")}
      hint={t("shell.networkPairing.nameHint")}
      value={name}
      onChange={(event) => setName(event.target.value)}
      {...errorProp(nameInvalid ? t("rules.name") : undefined)}
    />
  );

  const body = () => {
    if (confirmation) {
      return (
        <>
          <p>{t("shell.networkPairing.fingerprintBody")}</p>
          <p className="standalone-fingerprint-label">
            {t("shell.networkPairing.fingerprintLabel", { address: confirmation.address })}
          </p>
          <p className="standalone-fingerprint">{formatFingerprint(confirmation.fingerprint)}</p>
          <div className="standalone-form__actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                setNotice({ key: "shell.networkPairing.fingerprintDiffersNote" });
              }}
            >
              {t("shell.networkPairing.fingerprintDiffers")}
            </Button>
            <Button loading={busy} onClick={() => void confirm(confirmation)}>
              {t("shell.networkPairing.fingerprintMatches")}
            </Button>
          </div>
        </>
      );
    }
    if (manual) {
      return (
        <form className="standalone-form" onSubmit={(event) => void submitManual(event)} noValidate>
          {nameField}
          <Input
            label={t("shell.networkPairing.address")}
            hint={t("shell.networkPairing.addressHint")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            {...errorProp(addressInvalid ? t("shell.networkPairing.addressInvalid") : undefined)}
          />
          <Input
            label={t("shell.networkPairing.code")}
            hint={t("shell.networkPairing.codeHint")}
            mono
            value={code}
            onChange={(event) => setCode(event.target.value)}
            {...errorProp(codeInvalid ? t("shell.networkPairing.codeInvalid") : undefined)}
          />
          <div className="standalone-form__actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setManual(false);
                setNotice(null);
              }}
            >
              {t("shell.networkPairing.scanInstead")}
            </Button>
            <Button type="submit" loading={busy}>
              {t("shell.networkPairing.next")}
            </Button>
          </div>
        </form>
      );
    }
    return (
      <form className="standalone-form" onSubmit={(event) => void submitScan(event)} noValidate>
        {nameField}
        {/* A keyboard-wedge scanner types into the focused field and presses Enter. */}
        <Input
          label={t("shell.networkPairing.scan")}
          hint={t("shell.networkPairing.scanHint")}
          value={scan}
          onChange={(event) => setScan(event.target.value)}
          autoFocus
          spellCheck={false}
        />
        <div className="standalone-form__actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setManual(true);
              setNotice(null);
            }}
          >
            {t("shell.networkPairing.manual")}
          </Button>
          <Button type="submit" loading={busy}>
            {t("shell.networkPairing.pair")}
          </Button>
        </div>
      </form>
    );
  };

  return (
    <Card className="standalone-card" title={t("shell.networkPairing.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("shell.networkPairing.intro")}</p>
        {notice && <Alert tone="error">{t(notice.key, notice.values ?? {})}</Alert>}
        {body()}
        <div className="standalone-form__actions">
          <Button variant="secondary" disabled={busy} onClick={onBack}>
            {t("shell.networkPairing.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

3. В `apps/standalone/src/app/shell.ts`:

- фрагмент

```ts
export type PairingState =
  { kind: "idle" } | { kind: "pairing" } | { kind: "failed"; code: DeviceErrorCode };
```

заменить на

```ts
/** Pairing: with the host on this computer (idle, pairing, failed) or one in the network. */
export type PairingState =
  | { kind: "idle" }
  | { kind: "pairing" }
  | { kind: "failed"; code: DeviceErrorCode }
  | { kind: "network" };
```

- фрагмент

```ts
  | { kind: "pairing" }
  | { kind: "pair_failed"; code: DeviceErrorCode }
```

заменить на

```ts
  | { kind: "pairing" }
  | { kind: "network_pairing" }
  | { kind: "pair_failed"; code: DeviceErrorCode }
```

- фрагмент

```ts
  | { type: "pairing_retried" }
```

заменить на

```ts
  | { type: "pairing_retried" }
  | { type: "network_pairing_requested" }
  | { type: "network_pairing_cancelled" }
```

- комментарий `nextShellView` — фрагмент

```ts
 * station's `nextStationView`. Code pairing and line selection arrive in
 * plan 1c; until then an unpaired device can only pair with the host on
 * this computer.
```

заменить на

```ts
 * station's `nextStationView`. An unpaired device pairs with the host on
 * this computer on its own, or with a host in the network by a code when
 * the user asks for it; a paired station without a line chooses one.
```

- фрагмент

```ts
  if (status === null) {
    if (localHost.kind === "probing") return { kind: "loading" };
```

заменить на

```ts
  if (status === null) {
    if (state.pairing.kind === "network") return { kind: "network_pairing" };
    if (localHost.kind === "probing") return { kind: "loading" };
```

- в `shellReducer` фрагмент

```ts
    case "pairing_retried":
      return { ...state, pairing: { kind: "idle" } };
```

заменить на

```ts
    case "pairing_retried":
      return { ...state, pairing: { kind: "idle" } };
    case "network_pairing_requested":
      return { ...state, pairing: { kind: "network" } };
    case "network_pairing_cancelled":
      return { ...state, pairing: { kind: "idle" } };
```

4. В `apps/standalone/src/app/screens.tsx`:

- фрагмент

```tsx
  reason,
  address,
  onRetry,
}: {
  reason: HostProbeErrorCode;
  address: string;
  /** Function-typed property, not a TS method: kept safe to pass around unbound. */
  onRetry: () => void;
}) {
```

заменить на

```tsx
  reason,
  address,
  onRetry,
  onNetwork,
}: {
  reason: HostProbeErrorCode;
  address: string;
  /** Function-typed property, not a TS method: kept safe to pass around unbound. */
  onRetry: () => void;
  /** Pair with a host in the network instead; `null` for a device that is already paired. */
  onNetwork: (() => void) | null;
}) {
```

- фрагмент

```tsx
      <Alert tone="warn">{t(PROBE_REASON_KEY[reason])}</Alert>
      <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
```

заменить на

```tsx
      <Alert tone="warn">{t(PROBE_REASON_KEY[reason])}</Alert>
      <div className="standalone-form__actions">
        {onNetwork && (
          <Button variant="secondary" onClick={onNetwork}>
            {t("shell.hostMissing.network")}
          </Button>
        )}
        <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
      </div>
```

5. В `apps/standalone/src/app/App.tsx`:

- фрагмент

```tsx
  DeviceError,
  type DeviceApi,
```

заменить на

```tsx
  DeviceError,
  type ClaimInput,
  type DeviceApi,
```

- фрагмент

```tsx
import { LineSelect } from "./LineSelect.js";
```

заменить на

```tsx
import { LineSelect } from "./LineSelect.js";
import { NetworkPairing } from "./NetworkPairing.js";
```

- фрагмент

```tsx
  const selectLine = useCallback(
```

заменить на

```tsx
  const claim = useCallback(
    async (input: ClaimInput) => {
      dispatch({ type: "paired", status: await deviceApi.claim(input) });
    },
    [deviceApi],
  );

  const selectLine = useCallback(
```

- фрагмент

<!-- prettier-ignore -->
```tsx
        <HostMissingScreen reason={view.reason} address={address} onRetry={retryProbe} />
```

заменить на

<!-- prettier-ignore -->
```tsx
        <HostMissingScreen
          reason={view.reason}
          address={address}
          onRetry={retryProbe}
          onNetwork={unpaired ? () => dispatch({ type: "network_pairing_requested" }) : null}
        />
```

- фрагмент

<!-- prettier-ignore -->
```tsx
      {view.kind === "pairing" && <WaitScreen messageKey="shell.pairing.title" />}
```

заменить на

<!-- prettier-ignore -->
```tsx
      {view.kind === "pairing" && <WaitScreen messageKey="shell.pairing.title" />}
      {view.kind === "network_pairing" && (
        <NetworkPairing
          probe={hostProbe}
          onClaim={claim}
          onBack={() => dispatch({ type: "network_pairing_cancelled" })}
        />
      )}
```

6. В `apps/standalone/src/i18n/ru.json`:

- фрагмент

```json
      "retry": "Проверить снова"
    },
```

заменить на

```json
      "retry": "Проверить снова",
      "network": "Подключиться к хосту в сети"
    },
```

- фрагмент

```json
    "pairFailed": {
```

заменить на

```json
    "networkPairing": {
      "title": "Подключение к хосту в сети",
      "intro": "В офисе откройте раздел «Устройства» и нажмите «Подключить устройство».",
      "name": "Имя устройства",
      "nameHint": "Так устройство будет называться в офисе",
      "defaultName": "Станция",
      "scan": "Код с экрана офиса",
      "scanHint": "Наведите сканер на код на экране офиса",
      "pair": "Подключить",
      "manual": "Ввести адрес и код вручную",
      "scanInstead": "Отсканировать код",
      "address": "Адрес хоста",
      "addressHint": "Например, 192.168.1.10 или 192.168.1.10:45710",
      "addressInvalid": "Укажите адрес: 192.168.1.10 или 192.168.1.10:45710",
      "code": "Код подключения",
      "codeHint": "10 символов с экрана офиса",
      "codeInvalid": "Проверьте код: 10 символов",
      "next": "Далее",
      "fingerprintBody": "Сверьте отпечаток ниже с отпечатком хоста на экране офиса. Код уйдёт на хост, только если они совпадают.",
      "fingerprintLabel": "Отпечаток хоста {{address}}",
      "fingerprintMatches": "Отпечаток совпадает",
      "fingerprintDiffers": "Не совпадает",
      "fingerprintDiffersNote": "Отпечаток не совпал, код не отправлен. Проверьте адрес хоста.",
      "back": "Назад",
      "errors": {
        "notPayload": "Это не код подключения Markiro. Отсканируйте код с экрана офиса.",
        "noAddresses": "В коде нет адреса хоста: у ПК-хоста нет адреса в локальной сети. Проверьте его сеть или введите адрес вручную.",
        "notFound": "Хост из кода не отвечает ни по одному адресу ({{addresses}}). Проверьте, что ПК-хост включён и в той же сети.",
        "otherHost": "По адресу из кода отвечает другой хост: отпечаток не совпадает. Код не отправлен.",
        "unreachable": "Хост не отвечает по этому адресу. Проверьте адрес и что ПК-хост включён.",
        "notHost": "По этому адресу отвечает не служба Markiro.",
        "codeMaybeSpent": "Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова."
      }
    },
    "pairFailed": {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-search.test.ts test/network-pairing.test.tsx test/shell.test.ts test/app.test.tsx`
Expected: PASS — 16 тестов в `host-search.test.ts`, 15 в `network-pairing.test.tsx`, 32 в `shell.test.ts`, 34 в `app.test.tsx`.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` в конец раздела «Local pairing trust» добавить абзац:

```text
Pairing with a host in the network (`src/app/NetworkPairing.tsx`) sends
the code only to a confirmed host: a scanned payload is probed on every
address at once (`findHost`), and the code goes only to the address whose
certificate matches `f`; a typed address and code show the observed
fingerprint (`formatFingerprint`) and send the code only after a person
confirmed it against the office screen. A code that cannot be a code never
leaves the device, and a refused claim is never retried on its own.
```

2. В спецификации, §4.7, фрагмент

```text
- Устройство со сканированным кодом соединяется по первому доступному адресу, сверяет
  отпечаток сертификата с `f` и только потом отправляет код.
```

заменить на

```text
- Устройство со сканированным кодом опрашивает все адреса из кода одновременно (мёртвый
  адрес стоит таймаута соединения, а виртуальные адаптеры стоят в списке первыми), берёт
  первый, чей сертификат совпал с `f`, и только туда отправляет код. Код, который
  клавиатурный сканер набрал при русской раскладке, приводится к позициям клавиш US.
```

3. Там же, §5.1, в схеме состояний строку

```text
       └─ хоста на этом ПК нет                         → pairing (код или сканирование)
```

заменить на

```text
       └─ хоста на этом ПК нет                         → «хост не найден» → pairing в сети (код или сканирование)
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`; `git diff --check`.
Expected: всё зелёное.

```bash
git add apps/standalone/src/app/host-search.ts apps/standalone/src/app/NetworkPairing.tsx apps/standalone/test/host-search.test.ts apps/standalone/test/network-pairing.test.tsx apps/standalone/src/app/shell.ts apps/standalone/src/app/screens.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/app.test.tsx apps/standalone/test/shell.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): подключение к хосту в сети по коду" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Офисная страница «Устройства» и диалог кода подключения

Администратор видит подключённые устройства и выдаёт код для нового (спецификация, §4.7, §5.5). Список — `GET /v1/office/devices`. Имя линии берётся из локальных копий этой установки: офисного маршрута линий до плана 1d нет. Если линии в копиях ещё нет, показывается начало её id.

«Последний раз» — это `lastSeenAt`: хост меняет его не чаще раза в минуту, а поток — только при открытии. Поэтому колонка не называется «на связи».

Диалог показывает:

- машиночитаемый код для сканера;
- сам код;
- отпечаток и адреса хоста для ручного ввода — без адреса ручной путь невозможен, поэтому адреса добавлены к списку из решения;
- таймер.

Подключение по коду не поднимает ревизию хоста, так что событие о новом устройстве не приходит. Пока диалог открыт, список перечитывается каждые 3 с, и диалог закрывается сам, когда появляется устройство, подключённое после выдачи кода.

Кнопка «Новый код» есть всегда, а не только после истечения срока: код, погашенный пятью неверными попытками с любого устройства, выглядит для офиса живым, и текст в диалоге велит создать новый.

**Files:**

- Create: `apps/standalone/src/office/devices/DevicesPage.tsx`, `apps/standalone/src/office/devices/PairingCodeDialog.tsx`, `apps/standalone/src/office/devices/PairingDataMatrix.tsx`, `apps/standalone/src/office/office-local.tsx`
- Create: `apps/standalone/test/devices-page.test.tsx`
- Modify: `apps/standalone/src/host/api.ts`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/test/support/office.tsx`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/office-query.test.tsx`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes:
  - маршруты хоста `GET /v1/office/devices` и `POST /v1/office/pairing-codes` (план 1c1); `deviceRecordSchema`, `pairingCodeSchema`, типы `DeviceRecord`, `PairingCode`, `DeviceKind` (`src/host/protocol.ts`);
  - `renderLiteralDataMatrixSvg(text: string): string` (`@markiro/domain`);
  - задача 2: `parsePairingPayload`; `formatFingerprint` (`src/app/fingerprint.ts`);
  - задачи 3–4: `Office` со свойствами `link` и `hostRevision`; `LocalExecutor.query` (план 1c2, задача 5);
  - `useOfficeQuery`, `useOfficeMutation`, `officeKeys`, `RequireRole`, `PageLoading`, `LoadError`, `errorMessageKey`.
- Produces:
  - `HostApi.listDevices: (token: string) => Promise<DeviceRecord[]>`, `HostApi.createPairingCode: (token: string) => Promise<PairingCode>` и их записи в `fakeHostApi`;
  - `officeKeys.devices = ["office", "devices"]`, `officeKeys.lineNames = ["office", "line-names"]`;
  - `interface OfficeQueryOptions { refetchInterval?: number }`, `useOfficeQuery<T>(key, read, options?: OfficeQueryOptions)`;
  - `OfficeProps.local?: LocalExecutor | null`, `OfficeLocalProvider`, `useOfficeLocal(): LocalExecutor | null` (`src/office/office-local.tsx`);
  - `DevicesPage()`; `interface PairingCodeDialogProps { code: PairingCode; regenerating: boolean; failure: string | null; onRegenerate: () => void; onClose: () => void }`, `PairingCodeDialog(props)`, `DEVICE_POLL_MS = 3000`; `PairingDataMatrix({ payload, label })` — экспорт по умолчанию для `React.lazy`;
  - пункт меню `/devices` («Производство», только администратор).

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/devices-page.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { DeviceRecord, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const FINGERPRINT = "ab".repeat(32);
const HOST_PC: DeviceRecord = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  name: "Рабочее место хоста",
  lineId: LINE_ID,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: "2026-09-27T09:40:00Z",
  revokedAt: null,
};
const RETIRED: DeviceRecord = {
  id: "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f",
  kind: "handheld",
  name: "Старый ТСД",
  lineId: "9b2e4a6c-0000-4000-8000-000000000000",
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T10:00:00Z",
  lastSeenAt: null,
  revokedAt: "2026-09-26T12:00:00Z",
};

/** A code the host issued `secondsAgo` seconds ago: it lives 10 minutes. */
function pairingCode(secondsAgo: number, hosts = "10.0.0.5,192.168.1.10"): PairingCode {
  return {
    code: "7K3MQ9XV2D",
    expiresAt: new Date(Date.now() + (600 - secondsAgo) * 1000).toISOString(),
    payload: `markiro-host:1?h=${hosts}&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
  };
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listDevices.mockResolvedValue([HOST_PC, RETIRED]);
  return session;
}

async function openDevices(session: FakeOfficeSession, local = openLocalDb().executor) {
  renderOffice(session, { local });
  fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
  await screen.findByText("Рабочее место хоста");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("office devices", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is in the menu for administrators only", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Устройства" })).toBeNull();
    expect(screen.queryByText("Производство")).toBeNull();
  });

  it("lists the devices, naming lines from the local copies", async () => {
    const { db, executor } = openLocalDb();
    db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, 'Линия 1', 0, 3)").run(
      LINE_ID,
    );
    await openDevices(adminSession(), executor);
    expect(screen.getByText("Производство")).toBeTruthy();
    const station = rowOf("Рабочее место хоста");
    expect(within(station).getByText("Станция")).toBeTruthy();
    expect(within(station).getByText("Линия 1")).toBeTruthy();
    expect(within(station).getByText("Действует")).toBeTruthy();
    const retired = rowOf("Старый ТСД");
    expect(within(retired).getByText("ТСД")).toBeTruthy();
    // A line the copies do not know yet shows its short id.
    expect(within(retired).getByText("9b2e4a6c…")).toBeTruthy();
    expect(within(retired).getByText("—")).toBeTruthy();
    expect(within(retired).getByText("Отозвано")).toBeTruthy();
  });

  it("shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(30));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    const matrix = await within(dialog).findByRole("img", { name: "Код подключения для сканера" });
    expect(matrix.querySelector("svg")).not.toBeNull();
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(within(dialog).getByText("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB")).toBeTruthy();
    expect(within(dialog).getByText("10.0.0.5:45710, 192.168.1.10:45710")).toBeTruthy();
    expect(within(dialog).getByText(/^Код действует ещё 09:(30|29)$/)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "После пяти неверных попыток с любого устройства код перестаёт действовать. Если устройство пишет, что код неверен, создайте новый.",
      ),
    ).toBeTruthy();
    expect(session.api.createPairingCode).toHaveBeenCalledWith("office-session-token");
  });

  it("offers a new code once the code expired", async () => {
    const session = adminSession();
    session.api.createPairingCode
      .mockResolvedValueOnce(pairingCode(601))
      .mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText("Срок кода истёк. Создайте новый код.")).toBeTruthy();
    expect(screen.queryByText("7K3MQ 9XV2D")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Новый код" }));
    expect(await screen.findByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(session.api.createPairingCode).toHaveBeenCalledTimes(2);
  });

  it("warns when the host has no address in the local network", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0, ""));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(
      await screen.findByText(
        "У ПК-хоста нет адреса в локальной сети: устройство не найдёт хост по коду. Проверьте сеть ПК-хоста.",
      ),
    ).toBeTruthy();
  });

  it("reads the list every 3 s while the code shows and closes when the device paired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    await screen.findByRole("dialog");
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция на линии 2",
      lineId: null,
      pairedAt: new Date(Date.now() + 1000).toISOString(),
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, RETIRED, joined]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText("Устройство «Станция на линии 2» подключено.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("Станция на линии 2")).toBeTruthy();
  });

  it("reads the list again when the dialog is closed", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    const reads = session.api.listDevices.mock.calls.length;
    // The footer button; the × in the title bar is named «Закрыть» too.
    fireEvent.click(within(dialog).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
  });

  it("explains a code the host would not create", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockRejectedValue(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
    );
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

2. В `apps/standalone/test/api.test.ts` в список `CASES` фрагмент

```ts
  [
    "setUserPassword",
    null,
```

заменить на

```ts
  [
    "listDevices",
    [fixture("device-record.json")],
    (api) => api.listDevices(TOKEN),
    { method: "GET", path: "/v1/office/devices", body: undefined },
  ],
  [
    "createPairingCode",
    fixture("pairing-code.json"),
    (api) => api.createPairingCode(TOKEN),
    { method: "POST", path: "/v1/office/pairing-codes", body: undefined },
  ],
  [
    "setUserPassword",
    null,
```

3. В `apps/standalone/test/office-query.test.tsx` фрагмент

```tsx
  it("does not retry a failed read: the page explains it and offers a retry", async () => {
```

заменить на

```tsx
  it("reads again at the interval it is given, and never without one", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(PROFILE);
    session.api.listUsers.mockResolvedValue([]);
    renderHook(
      () => ({
        once: useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
        polled: useOfficeQuery(officeKeys.users, (api, token) => api.listUsers(token), {
          refetchInterval: 20,
        }),
      }),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(session.api.listUsers.mock.calls.length).toBeGreaterThan(2));
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed read: the page explains it and offers a retry", async () => {
```

- [ ] **Step 2: Запустить тесты — новые падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx test/api.test.ts test/office-query.test.tsx`
Expected: FAIL — в меню нет «Устройства», поэтому падают все тесты `devices-page.test.tsx`, кроме проверки, что технологу пункт не виден; в `api.test.ts` — `api.listDevices is not a function` и `api.createPairingCode is not a function`; запрос с интервалом читается один раз.

- [ ] **Step 3: Методы хоста, страница, диалог и меню**

1. В `apps/standalone/src/host/api.ts`:

- фрагмент

```ts
  changesResponseSchema,
  officeSessionSchema,
```

заменить на

```ts
  changesResponseSchema,
  deviceRecordSchema,
  officeSessionSchema,
```

- фрагмент

```ts
  orgProfileSchema,
  ssccCounterSchema,
```

заменить на

```ts
  orgProfileSchema,
  pairingCodeSchema,
  ssccCounterSchema,
```

- фрагмент

```ts
  type ChangesResponse,
  type OfficeLoginRequest,
```

заменить на

```ts
  type ChangesResponse,
  type DeviceRecord,
  type OfficeLoginRequest,
```

- фрагмент

```ts
  type OrgProfileUpdate,
  type PasswordChange,
```

заменить на

```ts
  type OrgProfileUpdate,
  type PairingCode,
  type PasswordChange,
```

- фрагмент

```ts
  getChanges: (since: number) => Promise<ChangesResponse>;
}
```

заменить на

```ts
  getChanges: (since: number) => Promise<ChangesResponse>;
  listDevices: (token: string) => Promise<DeviceRecord[]>;
  createPairingCode: (token: string) => Promise<PairingCode>;
}
```

- фрагмент

```ts
      client.request("GET", `/v1/changes?since=${since}`, { schema: changesResponseSchema }),
  };
```

заменить на

```ts
      client.request("GET", `/v1/changes?since=${since}`, { schema: changesResponseSchema }),
    listDevices: (token) =>
      client.request("GET", "/v1/office/devices", {
        officeToken: token,
        schema: z.array(deviceRecordSchema),
      }),
    createPairingCode: (token) =>
      client.request("POST", "/v1/office/pairing-codes", {
        officeToken: token,
        schema: pairingCodeSchema,
      }),
  };
```

2. В `apps/standalone/test/support/office.tsx` в `fakeHostApi` фрагмент

```tsx
    getChanges: vi.fn<HostApi["getChanges"]>(() => unexpected("getChanges")),
```

заменить на

```tsx
    getChanges: vi.fn<HostApi["getChanges"]>(() => unexpected("getChanges")),
    listDevices: vi.fn<HostApi["listDevices"]>(() => unexpected("listDevices")),
    createPairingCode: vi.fn<HostApi["createPairingCode"]>(() => unexpected("createPairingCode")),
```

3. В `apps/standalone/src/office/office-query.ts`:

- фрагмент

```ts
  users: ["office", "users"],
} as const;
```

заменить на

```ts
  users: ["office", "users"],
  devices: ["office", "devices"],
  /** Line names from this installation's local copies, not from the host. */
  lineNames: ["office", "line-names"],
} as const;
```

- фрагмент

```ts
/** Reads office data through `session.call`. */
export function useOfficeQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string) => Promise<T>,
): UseQueryResult<T, Error> {
  const { api, call } = useOfficeSession();
  return useQuery({ queryKey: key, queryFn: () => call((token) => read(api, token)) });
}
```

заменить на

```ts
export interface OfficeQueryOptions {
  /** Read again every this many milliseconds while mounted; never by default. */
  refetchInterval?: number;
}

/** Reads office data through `session.call`. */
export function useOfficeQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string) => Promise<T>,
  options: OfficeQueryOptions = {},
): UseQueryResult<T, Error> {
  const { api, call } = useOfficeSession();
  return useQuery({
    queryKey: key,
    queryFn: () => call((token) => read(api, token)),
    refetchInterval: options.refetchInterval ?? false,
  });
}
```

4. Create `apps/standalone/src/office/office-local.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { LocalExecutor } from "../local/executor.js";

const OfficeLocalContext = createContext<LocalExecutor | null>(null);

/** This installation's local copies of the host's reference data, for office screens. */
export function OfficeLocalProvider({
  value,
  children,
}: {
  value: LocalExecutor | null;
  children: ReactNode;
}) {
  return <OfficeLocalContext.Provider value={value}>{children}</OfficeLocalContext.Provider>;
}

/** `null` outside the app, as in office tests that do not pass one. */
export function useOfficeLocal(): LocalExecutor | null {
  return useContext(OfficeLocalContext);
}
```

5. В `apps/standalone/src/office/Office.tsx`:

- фрагмент

```tsx
import type { HostStatus } from "../host/protocol.js";
import { OfficeLinkProvider } from "./office-link.js";
```

заменить на

```tsx
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { OfficeLinkProvider } from "./office-link.js";
import { OfficeLocalProvider } from "./office-local.js";
```

- фрагмент

```tsx
  link?: HostStatus | null;
```

заменить на

```tsx
  link?: HostStatus | null;
  /** This installation's local copies; «Устройства» names lines from them. */
  local?: LocalExecutor | null;
```

- фрагмент

```tsx
export function Office({ session, link = null, hostRevision = null }: OfficeProps) {
```

заменить на

```tsx
export function Office({ session, link = null, local = null, hostRevision = null }: OfficeProps) {
```

- фрагмент

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={link}>
          <RouterProvider router={router} />
        </OfficeLinkProvider>
```

заменить на

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={link}>
          <OfficeLocalProvider value={local}>
            <RouterProvider router={router} />
          </OfficeLocalProvider>
        </OfficeLinkProvider>
```

6. В `apps/standalone/src/app/App.tsx` фрагмент

```tsx
        session={officeSession}
        link={state.link}
```

заменить на

```tsx
        session={officeSession}
        link={state.link}
        local={localDb}
```

7. Create `apps/standalone/src/office/devices/PairingDataMatrix.tsx`:

```tsx
import { renderLiteralDataMatrixSvg } from "@markiro/domain";

/**
 * The pairing payload as a DataMatrix code, after
 * `apps/admin/src/pages/devices/PairingBarcode.tsx`. Loaded on its own, since
 * the encoder is large. When it cannot draw the code, nothing shows: the code
 * and the fingerprint beside it stay the way to pair by hand.
 */
export default function PairingDataMatrix({ payload, label }: { payload: string; label: string }) {
  let svg: string | null;
  try {
    svg = renderLiteralDataMatrixSvg(payload);
  } catch {
    svg = null;
  }
  if (svg === null) return null;
  return (
    <div
      role="img"
      aria-label={label}
      className="pairing-code__matrix"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
```

8. Create `apps/standalone/src/office/devices/PairingCodeDialog.tsx`:

```tsx
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  DefinitionGrid,
  Modal,
  Spinner,
  VisuallyHidden,
  type DefinitionGridItem,
} from "@markiro/ui";

import { formatFingerprint } from "../../app/fingerprint.js";
import { parsePairingPayload } from "../../host/pairing-code.js";
import type { PairingCode } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";

const PairingDataMatrix = lazy(() => import("./PairingDataMatrix.js"));

/** How often the device list is read while a code is shown. */
export const DEVICE_POLL_MS = 3000;

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Milliseconds until `expiresAt`, ticking every second (after the admin's pairing panel). */
function useRemainingMs(expiresAt: string): number {
  const expiry = useMemo(() => new Date(expiresAt).getTime(), [expiresAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiry]);
  return Number.isNaN(expiry) ? 0 : Math.max(0, expiry - now);
}

export interface PairingCodeDialogProps {
  code: PairingCode;
  regenerating: boolean;
  /** Why a new code could not be created, as an i18n key. */
  failure: string | null;
  onRegenerate: () => void;
  onClose: () => void;
}

/**
 * A one-time pairing code (spec §4.7, §5.5): the DataMatrix for a scanner,
 * the code and the host's fingerprint and addresses for pairing by hand, and
 * the time left.
 */
export function PairingCodeDialog({
  code,
  regenerating,
  failure,
  onRegenerate,
  onClose,
}: PairingCodeDialogProps) {
  const { t } = useTranslation();
  // A claim does not raise the host revision, so no event announces the new
  // device: the list is read again every few seconds while the code shows.
  useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    refetchInterval: DEVICE_POLL_MS,
  });
  const remainingMs = useRemainingMs(code.expiresAt);
  const payload = parsePairingPayload(code.payload);
  const details: DefinitionGridItem[] = [];
  if (payload !== null) {
    details.push({
      id: "fingerprint",
      term: t("office.devices.pairing.fingerprint"),
      description: formatFingerprint(payload.fingerprint),
      mono: true,
    });
    if (payload.addresses.length > 0) {
      details.push({
        id: "addresses",
        term: t("office.devices.pairing.addresses"),
        description: payload.addresses.map((host) => `${host}:${payload.port}`).join(", "),
        mono: true,
      });
    }
  }

  return (
    <Modal
      open
      title={t("office.devices.pairing.title")}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" loading={regenerating} onClick={onRegenerate}>
            {t("office.devices.pairing.regenerate")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
        </>
      }
    >
      <div className="standalone-form">
        {failure && <Alert tone="error">{t(failure)}</Alert>}
        {/* Announces a new code or its expiry; the countdown stays outside. */}
        <div className="standalone-form" aria-live="polite">
          {remainingMs === 0 ? (
            <Alert tone="warn">{t("office.devices.pairing.expired")}</Alert>
          ) : (
            <>
              <p>{t("office.devices.pairing.intro")}</p>
              <div className="pairing-code">
                <Suspense fallback={<Spinner label={t("office.devices.pairing.matrixLoading")} />}>
                  <PairingDataMatrix
                    payload={code.payload}
                    label={t("office.devices.pairing.matrixLabel")}
                  />
                </Suspense>
                <span className="pairing-code__digits" aria-hidden="true">
                  {`${code.code.slice(0, 5)} ${code.code.slice(5)}`}
                </span>
                <VisuallyHidden>{code.code}</VisuallyHidden>
              </div>
              {payload !== null && payload.addresses.length === 0 && (
                <Alert tone="warn">{t("office.devices.pairing.noAddresses")}</Alert>
              )}
              <DefinitionGrid items={details} />
            </>
          )}
        </div>
        {remainingMs > 0 && (
          <p className="office-note">
            {t("office.devices.pairing.expiresIn", { time: formatCountdown(remainingMs) })}
          </p>
        )}
        <p className="office-note">{t("office.devices.pairing.attempts")}</p>
      </div>
    </Modal>
  );
}
```

9. Create `apps/standalone/src/office/devices/DevicesPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, PageHeader, StatusChip, Table, type TableColumn } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { DeviceRecord, PairingCode } from "../../host/protocol.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeLocal } from "../office-local.js";
import { LoadError, PageLoading } from "../page-state.js";
import { PairingCodeDialog } from "./PairingCodeDialog.js";

/** How long a code lives on the host (`pairing_code::CODE_LIFETIME`, spec §4.7). */
const CODE_LIFETIME_MS = 10 * 60 * 1000;

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });

const lineRow = z.object({ id: z.string(), name: z.string() });

interface Pairing {
  code: PairingCode;
  /** When the host issued the code, by its clock: a device paired since took the code. */
  issuedAt: number;
}

/** Line names from this installation's local copies; a line not there yet shows its id. */
function useLineNames() {
  const local = useOfficeLocal();
  return useQuery({
    queryKey: officeKeys.lineNames,
    queryFn: async () => {
      if (local === null) return new Map<string, string>();
      const rows = await local.query("SELECT id, name FROM ref_lines", [], lineRow);
      return new Map(rows.map((row) => [row.id, row.name]));
    },
  });
}

/** Paired devices and pairing codes (spec §5.5, administrators only; the route is wrapped in `RequireRole`). */
export function DevicesPage() {
  const { t } = useTranslation();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const lineNames = useLineNames();
  const create = useOfficeMutation((api, token, _variables: void) => api.createPairingCode(token));
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The dialog closes itself once a device paired after its code was issued.
  const joined =
    pairing === null
      ? undefined
      : devices.data?.find((device) => Date.parse(device.pairedAt) >= pairing.issuedAt);
  const dialogOpen = pairing !== null && joined === undefined;

  const newCode = async () => {
    setFailure(null);
    // A new attempt from the page drops the last notice.
    if (!dialogOpen) setPairing(null);
    try {
      const code = await create.mutateAsync();
      setPairing({ code, issuedAt: Date.parse(code.expiresAt) - CODE_LIFETIME_MS });
    } catch (error) {
      setFailure(errorMessageKey(error));
    }
  };

  const close = () => {
    setPairing(null);
    setFailure(null);
    void devices.refetch();
  };

  const lineLabel = (lineId: string | null) => {
    if (lineId === null) return t("office.common.none");
    return lineNames.data?.get(lineId) ?? `${lineId.slice(0, 8)}…`;
  };

  const columns: TableColumn<DeviceRecord>[] = [
    { key: "name", title: t("office.devices.table.name"), render: (device) => device.name },
    {
      key: "kind",
      title: t("office.devices.table.kind"),
      render: (device) => t(`office.devices.kinds.${device.kind}`),
    },
    {
      key: "line",
      title: t("office.devices.table.line"),
      render: (device) => lineLabel(device.lineId),
    },
    {
      key: "pairedAt",
      title: t("office.devices.table.pairedAt"),
      render: (device) => DATE_TIME.format(new Date(device.pairedAt)),
    },
    {
      // Updated at most once a minute, and by a stream only when it opens:
      // the time the host last heard from the device, not "online".
      key: "lastSeenAt",
      title: t("office.devices.table.lastSeenAt"),
      render: (device) =>
        device.lastSeenAt === null
          ? t("office.common.none")
          : DATE_TIME.format(new Date(device.lastSeenAt)),
    },
    {
      key: "status",
      title: t("office.devices.table.status"),
      render: (device) => (
        <StatusChip
          phase={device.revokedAt === null ? "active" : "retired"}
          label={t(
            device.revokedAt === null
              ? "office.devices.status.active"
              : "office.devices.status.revoked",
          )}
        />
      ),
    },
  ];

  const content = () => {
    if (devices.isPending) return <PageLoading />;
    if (devices.isError) {
      return <LoadError error={devices.error} onRetry={() => void devices.refetch()} />;
    }
    return (
      <Card>
        <Table
          columns={columns}
          rows={devices.data}
          getRowKey={(device) => device.id}
          empty={t("office.devices.empty")}
          scrollLabel={t("office.devices.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.devices.title")}
        actions={
          <Button loading={create.isPending && !dialogOpen} onClick={() => void newCode()}>
            {t("office.devices.add")}
          </Button>
        }
      />
      {joined && <Alert tone="ok">{t("office.devices.joined", { name: joined.name })}</Alert>}
      {failure && !dialogOpen && <Alert tone="error">{t(failure)}</Alert>}
      {content()}
      {pairing && dialogOpen && (
        <PairingCodeDialog
          code={pairing.code}
          regenerating={create.isPending}
          failure={failure}
          onRegenerate={() => void newCode()}
          onClose={close}
        />
      )}
    </>
  );
}
```

10. В `apps/standalone/src/office/nav.ts` фрагмент

```ts
  {
    to: "/users",
```

заменить на

```ts
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
  },
  {
    to: "/users",
```

11. В `apps/standalone/src/office/routes.tsx`:

- фрагмент

```tsx
import { OfficeOverview } from "./OfficeOverview.js";
```

заменить на

```tsx
import { DevicesPage } from "./devices/DevicesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
```

- фрагмент

```tsx
      { path: "sscc", element: <SsccPage /> },
```

заменить на

```tsx
      { path: "sscc", element: <SsccPage /> },
      {
        path: "devices",
        element: (
          <RequireRole roles={["admin"]}>
            <DevicesPage />
          </RequireRole>
        ),
      },
```

12. В `apps/standalone/src/app/shell.css` фрагмент (в конце файла)

```css
.office-note {
  margin: 0;
  color: var(--fg-2);
}
```

заменить на

```css
.office-note {
  margin: 0;
  color: var(--fg-2);
}

.pairing-code {
  display: grid;
  justify-items: center;
  gap: 12px;
}

/* The SVG has only a viewBox: the box gives it a size, and a light quiet zone in both themes. */
.pairing-code__matrix {
  width: 200px;
  height: 200px;
  padding: 12px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--r-2);
}

.pairing-code__matrix svg {
  display: block;
  width: 100%;
  height: 100%;
}

.pairing-code__digits {
  font: var(--text-h1);
  font-family: var(--font-mono);
  letter-spacing: 0.12em;
}
```

13. В `apps/standalone/src/i18n/ru.json`:

- фрагмент

```json
      "sections": { "office": "Офис", "organization": "Организация", "access": "Доступ" },
      "overview": "Обзор",
      "orgProfile": "Профиль",
      "sscc": "SSCC",
      "users": "Пользователи"
```

заменить на

```json
      "sections": {
        "office": "Офис",
        "organization": "Организация",
        "production": "Производство",
        "access": "Доступ"
      },
      "overview": "Обзор",
      "orgProfile": "Профиль",
      "sscc": "SSCC",
      "devices": "Устройства",
      "users": "Пользователи"
```

- фрагмент

```json
    "noAccess": {
```

заменить на

```json
    "devices": {
      "title": "Устройства",
      "add": "Подключить устройство",
      "empty": "Устройств пока нет.",
      "joined": "Устройство «{{name}}» подключено.",
      "table": {
        "name": "Имя",
        "kind": "Вид",
        "line": "Линия",
        "pairedAt": "Подключено",
        "lastSeenAt": "Последний раз",
        "status": "Доступ"
      },
      "kinds": {
        "station": "Станция",
        "office": "Офис",
        "handheld": "ТСД"
      },
      "status": {
        "active": "Действует",
        "revoked": "Отозвано"
      },
      "pairing": {
        "title": "Подключение устройства",
        "intro": "Отсканируйте код сканером подключаемого устройства или введите на нём адрес хоста и код.",
        "matrixLabel": "Код подключения для сканера",
        "matrixLoading": "Готовим код для сканера…",
        "fingerprint": "Отпечаток хоста",
        "addresses": "Адрес хоста",
        "noAddresses": "У ПК-хоста нет адреса в локальной сети: устройство не найдёт хост по коду. Проверьте сеть ПК-хоста.",
        "expiresIn": "Код действует ещё {{time}}",
        "expired": "Срок кода истёк. Создайте новый код.",
        "regenerate": "Новый код",
        "attempts": "После пяти неверных попыток с любого устройства код перестаёт действовать. Если устройство пишет, что код неверен, создайте новый."
      }
    },
    "noAccess": {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx test/api.test.ts test/office-query.test.tsx`
Expected: PASS — 8 тестов в `devices-page.test.tsx`, 15 в `api.test.ts`, 5 в `office-query.test.tsx`.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` в конец раздела «Office pages» добавить пункт списка:

```text
- «Устройства» lists `GET /v1/office/devices`; line names come from this
  installation's local copies (`useQuery` with `officeKeys.lineNames` — a
  local read, not a host request), and `lastSeenAt` is «Последний раз»,
  never «на связи»: the host touches it at most once a minute and a stream
  only when it opens. A claim raises no revision, so the pairing-code
  dialog reads the list every 3 s (`DEVICE_POLL_MS`) and closes once a
  device paired after the code was issued appears. The DataMatrix encoder
  loads lazily (`PairingDataMatrix`); when it fails, the typed code, the
  fingerprint and the host's addresses stay the way to pair.
```

2. В спецификации, §5.5, фрагмент

```text
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом и таймером.
```

заменить на

```text
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
  поднимает ревизию, и событие потока о нём не приходит. Диалог закрывается сам,
  когда появляется устройство, подключённое после выдачи кода. «Последний раз» —
  время последнего запроса устройства, а не признак связи. План 1c даёт список и
  диалог; переименование, линию и отзыв — план 1d.
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build`; `git diff --check`.
Expected: всё зелёное. Сборка выносит кодировщик DataMatrix в отдельный кусок `PairingDataMatrix-*.js`; предупреждение о размере куска больше 500 КБ было и раньше.

```bash
git add apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/PairingCodeDialog.tsx apps/standalone/src/office/devices/PairingDataMatrix.tsx apps/standalone/src/office/office-local.tsx apps/standalone/test/devices-page.test.tsx apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/Office.tsx apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/api.test.ts apps/standalone/test/office-query.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): офисная страница «Устройства» и диалог кода подключения" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build` — зелёные; вывод Vitest без предупреждений `act(...)`.
- [ ] `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'` (крейт оболочки встраивает `apps/standalone/dist`), затем `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` вне песочницы: тесты хоста и оболочки слушают 127.0.0.1. Все тесты PASS, без предупреждений компилятора. Из Rust план меняет только фикстуру и тест `proto`.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам — чисто; `git diff --check <начало плана>..HEAD` — чисто.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `apps/station`, `apps/admin`, Rust-код хоста и оболочки не менялись.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - второй ПК в настоящей локальной сети: сканирование DataMatrix с экрана офиса, ручной ввод со сверкой отпечатка, поток изменений и синхронизация через сеть — вручную, на двух ПК;
  - настоящий клавиатурный сканер при русской раскладке (и с Caps Lock): тесты подставляют текст, который сканер должен набрать, но не нажимают клавиши;
  - окно `tauri dev`: события связи в настоящем вебвью, локальная база через команды оболочки, вид экранов и диалога в тёмной и светлой теме;
  - задание CI `standalone-windows-build` — для него нужен push;
  - как читается DataMatrix с экрана сканерами на площадке (размер модуля, блики).
