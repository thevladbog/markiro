# План 1d3: офис — общая инфраструктура записи, контрагенты, линии, устройства и подхват назначенной линии станцией — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Администратор ведёт из офиса контрагентов и линии, переименовывает устройства, назначает станциям линии и отзывает устройства; технолог видит контрагентов и линии без права правки. Диалоги офиса получают одну общую основу записи, и существующие диалоги переходят на неё. «Новый код» гасит код на экране, а срок кода берётся у хоста. Станция узнаёт о линии, назначенной или снятой в офисе, и больше не затирает её молча своим выбором.

**Architecture:**

- `src/office/FormDialog.tsx`, `src/office/form-errors.ts`, `src/office/page-state.tsx`, `src/office/access.ts` — общая основа записи:
  - диалог вокруг одной формы, который сам держит отправку: не закрывается и не отправляет второй раз, пока запрос идёт;
  - `writeFailure` раскладывает отказ хоста по полю, по ограничению `conflict`, по «данные изменились» и по тексту;
  - `WriteFailureAlert` и `useFieldError` убирают повтор из форм;
  - `useCan` решает по таблице §4.8, форма на странице или только чтение.
- `src/lib/rules.ts` — правило свободного текста как у хоста (`validate::clean_text`) и правила полей компании, общие для организации и контрагентов.
- `src/host/protocol.ts`, `src/host/requests.ts`, `src/host/api.ts` — схемы Zod для фикстур плана 1d2, по одному сборщику тела на запрос (поле за полем, без разворота значений формы) и новые методы `HostApi`.
- `src/office/counterparties/*`, `src/office/lines/*` — страницы «Контрагенты» и «Линии»; `src/office/records.tsx` — естественная сортировка и хранение сохранённой записи в кэше.
- `src/office/devices/*` — правка имени и линии одним диалогом, отзыв с подтверждением, «Новый код» с `replaces`, срок кода от хоста; названия линий — из списка хоста.
- `src-tauri/src/device.rs`, `src-tauri/src/lib.rs` — `DeviceState::refresh` и команда `device_refresh`: станция перечитывает `GET /v1/device` и сохраняет изменившуюся линию в `device.json`.
- `src/host/device.ts`, `src/app/shell.ts`, `src/app/host-link.ts`, `src/app/App.tsx` — привязка `refresh`, действие `device_refreshed` и вызов после первой синхронизации и каждого события ревизии, по одному чтению за раз.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, react-hook-form 7.85, TanStack Query 5.101, i18next, `@markiro/ui` (`Modal`, `Select` в режиме `native`, `Checkbox`, `StatusChip`), Vitest 4 с jsdom; Rust — Tauri 2 (mock runtime в тестах IPC), reqwest 0.13.4, настоящий `markiro-host` на 127.0.0.1 в интеграционных тестах.

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1d3-design.md`: границы плана и обязательные решения; всё, что брифом не названо, — в разделе «Перенесено».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`:
  - §4.3 — текстовые поля, контрагенты, линии;
  - §4.5 — протокол и фикстуры плана 1d2;
  - §4.6 — ошибки;
  - §4.7 — коды подключения и `replaces`;
  - §4.8 — роли;
  - §5.1, §5.2 — оболочка и её команды;
  - §5.5 — офис.
- План 1d2 (`docs/superpowers/plans/2026-09-27-standalone-1d2-host-people-devices.md`) и его «Отклонения при исполнении»: маршруты хоста, коды ошибок, фикстуры и перенесённое в 1d3. Планы 1c3 и 1d1 — образец диалога кода, связи и синхронизации.

## Global Constraints

**Роли (спецификация §4.8)**

| Раздел                                               | Администратор   | Технолог                    |
| ---------------------------------------------------- | --------------- | --------------------------- |
| «Контрагенты» (меню «Организация»)                   | чтение и запись | чтение                      |
| «Линии» (меню «Производство»)                        | чтение и запись | чтение                      |
| «Устройства» (меню «Производство»), коды подключения | чтение и запись | нет доступа (`RequireRole`) |

- Права проверяет хост; офис только решает, что показать. Страница решает «форма или только чтение» одной функцией — `useCan(capability)` из `src/office/access.ts`, по таблице `CAPABILITIES`:
  - `editReference: ["admin"]` — организация, счётчики SSCC, контрагенты, линии;
  - `editCatalog: ["admin", "technologist"]` — каталог, шаблоны и их умолчания (план 1e).
- Технолог видит список без кнопок «Добавить», «Изменить», «Переименовать», «В архив», «Вернуть» и с пометкой `office.common.readOnly` («Изменять эти данные может только администратор.»).
- Меню: «Контрагенты» — после «SSCC» в «Организация», «Линии» — перед «Устройства» в «Производство», обе для `["admin", "technologist"]`. Пункты одного раздела стоят подряд: `Sidebar` подписывает раздел над подряд идущими пунктами.

**Правила полей (зеркало `host/src/validate.rs`)**

- Свободный текст (`validate::clean_text`): значение обрезается (`trim`), длина считается в символах (`[...text].length`, скалярные значения Юникода), любой управляющий символ — отказ: `/\p{Cc}/u`, то есть U+0000–U+001F и U+007F–U+009F, как `char::is_control`. `trim` в JavaScript и Rust расходятся только по краям: NEL (U+0085) JavaScript не обрезает, и форма его отвергает, а BOM (U+FEFF) обрезает, и хост его не получает. Форма никогда не мягче хоста.
- Функции — `isPlainText(text, max)` и `plainTextRule(max, message)` в `src/lib/rules.ts`. Правило действует на каждое текстовое поле этого плана и на прежние общие правила:
  - название контрагента и организации — 1–200 символов, `rules.orgName`;
  - название линии — 1–100, `rules.lineName` (новое);
  - имя устройства — 1–100, `rules.name`;
  - имя человека — 1–100, `rules.name`;
  - строки линий мастера — 1–100, `wizard.errors.lineName`.
- ИНН — после обрезки `^(\d{10}|\d{12})?$`; пустой уходит как `null`.
- GLN — `^\d{13}$` и контрольная цифра GS1 (`hasValidCheckDigit` из `@markiro/domain`). Контрольную цифру проверяет только интерфейс, как у профиля организации.
- Префиксы GS1 — одна строка, делится по `[\s,;]+`, повторы схлопываются; не больше 10, каждый `^\d{4,12}$` (`parsePrefixList`).
- Правила полей компании — `innRule`, `glnRule`, `gs1PrefixesRule`, `companyNameRule`; они общие для профиля организации и контрагента.

**Ошибки хоста (спецификация §4.6)**

- `validation_failed` с `details.field`, которое форма знает, — ошибка под этим полем. По умолчанию текст `rules.rejected` («Хост не принял это значение. Проверьте его.»). Свои тексты:
  - `lineId` у устройства — `office.devices.errors.lineRejected`;
  - `newPassword` при смене своего пароля — `rules.password`.
- `conflict` с `details.constraint` — ошибка под полем:
  - `line_name` — под названием линии, `office.lines.errors.nameTaken` («Активная линия с таким названием уже есть»), при добавлении, переименовании и возврате из архива;
  - `login` — под логином, `office.users.errors.loginTaken`;
  - `badge` — план 1d4.

  Незнакомое ограничение — предупреждение `errors.api.conflict`.

- `stale_revision` (`details.currentRev` не используется для повтора) — `StaleAlert` с «Загрузить заново», если форма умеет перечитать данные; иначе текст `errors.api.stale_revision`.
- Прочее — предупреждение над полями по коду (`errorMessageKey`). У устройств нет ревизии, и `stale_revision` от них не приходит.
- Поле и ограничение ищутся только среди собственных ключей карты (`Object.hasOwn`): поле `constructor` от хоста не превращается в `Object`.

**Тела запросов**

Каждое тело собирается поле за полем одной функцией из `src/host/requests.ts`; значения формы никогда не разворачиваются в запрос (`...values`). Идентификаторы идут только в путь; схемы ответов читают их как `z.uuid()`, а `host_request` отвергает `%`.

| Сборщик                                              | Тело                                                                        | Фикстура                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| `counterpartyCreate(company)`                        | `{ name, inn, gln, gs1Prefixes }`, `inn: null` — нет ИНН                    | `counterparty-create.json`  |
| `counterpartyUpdate(company, archived, expectedRev)` | запись целиком                                                              | `counterparty-update.json`  |
| `lineCreate(name)`                                   | `{ name }`                                                                  | `line-create.json`          |
| `lineUpdate(line, { name, archived })`               | только отличающиеся `name` и `archived`, всегда `expectedRev`               | `line-update.json`          |
| `deviceUpdate(device, { name, lineId })`             | только отличающиеся поля; `lineId` — только у станции, `null` снимает линию | `device-update.json`        |
| `pairingCodeRequest(replaces)`                       | `{ replaces }`                                                              | `pairing-code-request.json` |

- Без кода на экране «Подключить устройство» вызывает `createPairingCode(token)`: тела нет вовсе.
- Схемы ответов (`counterpartyRecordSchema`, `officeLineSchema`) — нестрогий `z.object`. Схемы тел — `.strict()`.
- `test/protocol.test.ts` проверяет, что каждая схема разбирает свою фикстуру и что каждый сборщик собирает свою фикстуру точно (`toStrictEqual`).

**Код подключения**

- Срок жизни берётся у хоста как длительность: `codeLifetimeMs(code) = max(0, Date.parse(expiresAt) − Date.parse(createdAt))`.
- Конец отсчёта — по часам этого ПК: `deadline = requestedAt + codeLifetimeMs(code)`, где `requestedAt = Date.now()` берётся до отправки запроса. Остаток зажат в `[0, lifetime]`.
- Метка хоста никогда не сравнивается с часами этого ПК. Обнаружение подключения сравнивает метки хоста между собой: устройство с `pairedAt ≥ createdAt` взяло код.
- `CODE_LIFETIME_MS` удаляется. Поколение запросов, опрос списка раз в 3 с (`DEVICE_POLL_MS`) и DataMatrix не меняются.
- «Новый код» шлёт `{ replaces: <id кода на экране> }`. Второй щелчок, пока запрос идёт, ничего не отправляет — флаг `requesting`, а не `isPending`: тот доходит до кнопки на такт позже.

**Сортировка**

`activeFirstByName` в `src/office/records.tsx`: действующие записи раньше архивных, внутри — `new Intl.Collator("ru", { numeric: true }).compare` по названию, при равных названиях — по `id`. Хост сортирует побайтно («Линия 10» раньше «Линия 2»), поэтому страница сортирует сама.

**Подхват линии станцией (решение контроллера; владелец может его отменить)**

- Rust — `DeviceState::refresh()`:
  - `GET /v1/device` с ключом устройства под той же блокировкой `pairing`, что у подключения, сброса и `select_line`;
  - ответ разбирается как `DeviceInfo`; `device.json` пишется, только если линия изменилась; обновляется подключение в памяти; возвращается `DeviceStatus`;
  - общий хвост с `select_line` — `keep_line`;
  - `401` — `key_rejected`; нет связи — `unreachable`, и ничего не меняется: без хоста станция остаётся на своей линии;
  - команда `device_refresh` в `lib.rs` и в списке `invoke_handler`.
- Вебвью:
  - `deviceApi.refresh` — свойство-функция (`useHostLink` берёт её несвязанной);
  - действие `{ type: "device_refreshed"; status }` меняет `device.status`, только если ответ про то же подключение (`deviceId` и `hostId`) и линия другая;
  - `useHostLink` вызывает `refresh` после первого запуска синхронизации (обе ветки `watch`) и на каждое событие ревизии, через `createSyncScheduler`: одно чтение за раз, события во время чтения дают ровно одно следующее.
- Ошибки: `deviceRejection` переводит `key_rejected` в экран отказа `key_rejected`, `certificate_mismatch` — в `host_changed`, как на всех путях к хосту. Остальное (`unreachable`, `storage`, `request_failed`) тихо игнорируется до следующего события.
- Снятая линия (`null`) возвращает станцию на выбор линии — это прежнее правило `nextShellView`; назначенная переводит на неё.
- Что смена линии значит для идущей смены — решение плана 2a; на этапе 1 цех — заглушка.

**Тексты**

- Каждый видимый текст — ключ в `src/i18n/ru.json`, ровно как в шагах задач. Кавычки — «ёлочки»; подписи полей и кнопок без точки, предложения — с точкой.
- Новые группы ключей: `rules.lineName`, `office.nav.counterparties`, `office.nav.lines`, `office.common.active`, `office.common.archived`, `office.common.archivedName`, `office.counterparties.*`, `office.lines.*`, `office.devices.table.actions`, `office.devices.edit*`, `office.devices.revoke*`, `office.devices.fields.*`, `office.devices.noLine`, `office.devices.revoked`, `office.devices.errors.lineRejected`.
- Прежние тексты не меняются: тесты `network-pairing` и мастера закрепляют `rules.name` и `rules.orgName`.

**Решения планировщика** (открытые места брифа)

- Названия линий в таблице «Устройства» — из `GET /v1/office/lines` хоста, того же списка, что предлагает диалог. Так таблица и диалог называют линии одинаково, линия, добавленная минуту назад, видна сразу, а архивная помечена «в архиве». Чтение локальных копий в офисе больше никому не нужно: `office-local.tsx`, свойство `local` у `Office` и `officeKeys.lineNames` удаляются.
- Архив контрагента — флажок «В архиве» в диалоге правки: `PUT` и так несёт запись целиком, а архив обратим, поэтому отдельного подтверждения нет.
- Возврат линии из архива — диалог с полем названия: `conflict` на `line_name` при возврате ложится под название, и линию можно тут же переименовать.
- Подтверждения («В архив» для линии, «Отозвать» для устройства) — тоже `FormDialog` с кнопкой `destructive`: один порядок занятости, закрытия и ошибок, «Загрузить заново» для устаревшей линии.
- `FormDialog` сам держит отправку (от отправки формы до завершения её промиса), а не берёт `submitting` снаружи: запрет закрытия и второй отправки не зависит от того, когда react-hook-form или TanStack Query доставят свой флаг.
- `writeFailure(error, fields, conflicts = {})` — третий параметр, прежние вызовы и тесты не меняются. Значение карты полей — имя поля или `{ field, message }` со своим текстом. Для подтверждений без полей — `alertFailure(error)`.
- `useFieldError` добавлен: он убирает двухстрочный помощник из семи прежних форм и нужен трём новым диалогам.
- Кроме пяти диалогов на общую основу переходят `BlockSizesForm` и `OrgProfileForm` (`WriteFailureAlert`, `useFieldError`). Тело `BlockSizesForm` собирается явно вместо `{ ...sizes }`. `SsccPage` и `OrgProfilePage` решают «форма или чтение» через `useCan`.
- `select_line` и `refresh` делят `keep_line`: `select_line` больше не переписывает `device.json`, если линия та же.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui`: ESLint запрещает нативные поля в `src/`. Линия устройства — `Select` в режиме `native`: в jsdom его выбирают `fireEvent.change`, а экранный диктор читает как обычный список.
- Доступность: у полей подписи; у кнопок в строках — `aria-label` с именем записи; состояние — `StatusChip` со словом, не только цветом.
- Новых зависимостей нет — ни JS, ни Rust. `apps/station`, `apps/standalone/host` и `apps/standalone/proto` не меняются.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в файле он встречается один раз. Правки внутри шага идут сверху вниз по файлу, одна за другой.
- «Заменить содержимое … целиком» — файл пишется заново, ровно как в блоке. «Create» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`: после правки проверьте байты (`grep -nF '\u04' <файл>` ничего не находит). Исключение — намеренные экранирования управляющих и невидимых символов в тесте правил (`"\u0000"`, `"\u00a0"` и соседние): они стоят в блоке именно так.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON и MD: код в плане уже отформатирован, расхождение значит опечатку.
- В задаче 7 — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.
- `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от эффекта, — скрытый флейк. «Ровно N раз» проверяется так: `waitFor`, два хода `await new Promise((resolve) => setImmediate(resolve))`, снова та же проверка. События поддельной связи доставляются через асинхронный `act` (`fakeConnection` в `test/app.test.tsx` уже так делает).
- Новые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст (нет предупреждений `act(...)` и ошибок React).
- Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.

**Cargo (задача 7)**

- Крейт оболочки встраивает `apps/standalone/dist`, поэтому перед cargo — `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`.
- Тесты `--test line` и почти все `--test ipc` поднимают настоящий хост на 127.0.0.1 — только вне песочницы. Тест `--test ipc an_unpaired_device_has_nothing_to_refresh` порт не слушает и идёт в песочнице с `--offline`.
- Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/src/office/{FormDialog.tsx,access.ts}                          задача 1
apps/standalone/src/office/{form-errors.ts,page-state.tsx}                     задача 1
apps/standalone/src/office/{ChangePasswordDialog.tsx,users/*Dialog.tsx}        задача 1
apps/standalone/src/office/sscc/{CounterDialog,BlockSizesForm,SsccPage}.tsx    задача 1
apps/standalone/src/office/org/OrgProfilePage.tsx                              задача 1
apps/standalone/test/{form-errors.test.ts,form-dialog.test.tsx}                задача 1
apps/standalone/src/lib/rules.ts, src/wizard/wizard-form.ts                    задача 2
apps/standalone/test/{rules,wizard-form}.test.ts                               задача 2
apps/standalone/src/host/{protocol.ts,requests.ts,api.ts}                      задача 3
apps/standalone/test/{protocol,api}.test.ts, test/support/office.tsx           задача 3
apps/standalone/src/office/records.tsx, src/office/counterparties/*            задача 4
apps/standalone/test/counterparties-page.test.tsx                              задача 4
apps/standalone/src/office/lines/*, test/lines-page.test.tsx                   задача 5
apps/standalone/src/office/{nav.ts,routes.tsx,office-query.ts}                 задачи 4, 5, 6
apps/standalone/src/office/devices/*, test/devices-page.test.tsx               задачи 5, 6
apps/standalone/src/office/{Office.tsx,office-local.tsx}                       задача 6
apps/standalone/src/i18n/ru.json                                               задачи 2, 4, 5, 6
apps/standalone/src-tauri/src/{device,lib}.rs, src-tauri/tests/{line,ipc}.rs   задача 7
apps/standalone/src/host/device.ts, src/app/{shell,host-link}.ts               задача 7
apps/standalone/test/{device,shell}.test.ts                                    задача 7
apps/standalone/src/app/App.tsx, test/app.test.tsx                             задачи 6, 7
apps/standalone/AGENTS.md                                                      задачи 1–7
спецификация: §5.5 — задачи 4, 5, 6; §4.4, §4.5, §5.1, §5.2 — задача 7
```

Задача 2 (правила полей) стоит отдельно от первой: задача 1 меняет только диалоги и держит их тесты неизменными, а правило свободного текста меняет поведение общих правил. Навигация и маршруты вошли в задачи 4 и 5, чьи страницы они открывают. Удаление чтения локальных копий из офиса — в задаче 6: после неё его никто не использует.

---

### Task 1: Общая инфраструктура записи офиса — `FormDialog`, `writeFailure`, `useCan`

Диалоги офиса повторяют один порядок: `useId`, состояние ошибки, `useOfficeMutation`, `useForm`, помощник `fieldError`, запрет закрытия во время отправки, раскладка `HostError` по полю или по предупреждению и `Modal` с «Отмена» и кнопкой отправки через `form={formId}`. Задача выносит его в общие части и переводит на них пять существующих диалогов: `CreateUserDialog`, `EditUserDialog`, `SetPasswordDialog`, `ChangePasswordDialog`, `CounterDialog`. Их тесты (`users-page`, `sscc-page`, `office`) — страховка и не меняются. Формы `BlockSizesForm` и `OrgProfileForm` — не диалоги, но берут `WriteFailureAlert` и `useFieldError`; тело `BlockSizesForm` собирается явно.

Новые части:

- `FormDialog` сам держит отправку: от отправки формы до завершения промиса `onSubmit` диалог не закрывается (Escape, подложка, ×, «Отмена») и вторую отправку отбрасывает. Флаг ставится сразу, в обработчике, а не ждёт, пока react-hook-form или TanStack Query доставят свой.
- `writeFailure(error, fields, conflicts = {})` раскладывает и `conflict` по `details.constraint`; значение карты полей может нести свой текст (`{ field, message }`); ключи ищутся только среди собственных. `alertFailure(error)` — для подтверждений без полей.
- `WriteFailureAlert` — «данные изменились» с «Загрузить заново», когда форма умеет перечитать данные, иначе текст ошибки. `useFieldError()` — свойство `error` поля по ключу текста, с подстановками.
- `useCan(capability)` — таблица §4.8 в одном месте.

**Files:**

- Create: `apps/standalone/src/office/FormDialog.tsx`, `apps/standalone/src/office/access.ts`, `apps/standalone/test/form-dialog.test.tsx`
- Modify (целиком): `apps/standalone/src/office/form-errors.ts`, `apps/standalone/src/office/users/{CreateUserDialog,EditUserDialog,SetPasswordDialog}.tsx`, `apps/standalone/src/office/ChangePasswordDialog.tsx`, `apps/standalone/src/office/sscc/CounterDialog.tsx`, `apps/standalone/test/form-errors.test.ts`
- Modify: `apps/standalone/src/office/page-state.tsx`, `apps/standalone/src/office/sscc/{BlockSizesForm,SsccPage}.tsx`, `apps/standalone/src/office/org/OrgProfilePage.tsx`, `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes:
  - `HostError` (`code`, `details`, `field`, `credential`) — `src/host/client.ts`; `errorMessageKey(error): string` — `src/host/errors.ts`;
  - `useOfficeMutation`, `useOfficeSession().user.role` — `src/office/office-query.ts`, `src/office/office-session.tsx`;
  - `Modal`, `Button`, `Alert` — `@markiro/ui`; `StaleAlert` — `src/office/page-state.tsx`.
- Produces:
  - `FormDialog(props: FormDialogProps)`, где `FormDialogProps { title: string; submitLabel: string; submitDisabled?: boolean; submitVariant?: "primary" | "destructive"; open?: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>; onClose: () => void; alert?: ReactNode; children: ReactNode }`;
  - `type AlertFailure = Exclude<WriteFailure<string>, { kind: "field" }>`, `interface FieldMessage<F> { field: F; message: string }`;
  - `writeFailure<F>(error, fields: Readonly<Record<string, F | FieldMessage<F>>>, conflicts?: Readonly<Record<string, FieldMessage<F>>>): WriteFailure<F>`, `alertFailure(error): AlertFailure`, `failureMessage(failure: AlertFailure): string`;
  - `useFieldError(): (message: string | undefined, values?: Record<string, unknown>) => { error?: string }`;
  - `WriteFailureAlert({ failure, onReload? })` — `src/office/page-state.tsx`;
  - `type OfficeCapability = "editReference" | "editCatalog"`, `can(role, capability): boolean`, `useCan(capability): boolean` — `src/office/access.ts`.

- [ ] **Step 1: Тесты (падающие)**

Тест `writeFailure` дополнен: конфликт по известному и неизвестному ограничению, свой текст поля, собственные ключи, `alertFailure`. Новый файл проверяет `FormDialog` (кнопки, закрытие, ожидание отправки, пометка `destructive`, место для ошибки), `WriteFailureAlert` и `useCan`.

1. Create `apps/standalone/test/form-dialog.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { can, useCan } from "../src/office/access.js";
import { FormDialog, type FormDialogProps } from "../src/office/FormDialog.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { WriteFailureAlert } from "../src/office/page-state.js";
import { fakeOfficeSession, TECHNOLOGIST } from "./support/office.js";

function renderDialog(props: Partial<FormDialogProps> = {}) {
  const onSubmit = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(
    <FormDialog
      title="Новая линия"
      submitLabel="Добавить"
      onSubmit={onSubmit}
      onClose={onClose}
      {...props}
    >
      <p>Поля формы</p>
    </FormDialog>,
  );
  return { onSubmit, onClose };
}

describe("FormDialog", () => {
  it("shows the title, the fields and both buttons, and sends the form", async () => {
    const { onSubmit, onClose } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Новая линия" });
    expect(dialog.querySelector("form")?.textContent).toBe("Поля формы");
    // `onSubmit` settles at once: `act` lets the dialog's own state follow it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with Cancel, Escape and the ×", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("waits while the form is being sent: no second send, no way to close", async () => {
    let finish: () => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { onClose } = renderDialog({ onSubmit });
    const submit = screen.getByRole("button", { name: "Добавить" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      finish();
    });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps the submit button off when asked, and marks a destructive action", () => {
    renderDialog({ submitDisabled: true, submitVariant: "destructive" });
    const submit = screen.getByRole("button", { name: "Добавить" });
    expect(submit).toHaveProperty("disabled", true);
    expect(submit.className).toContain("mk-btn--destructive");
  });

  it("shows the alert above the fields", () => {
    renderDialog({ alert: <p>Хост не ответил</p> });
    const form = screen.getByRole("dialog").querySelector("form");
    expect(form?.firstElementChild?.textContent).toBe("Хост не ответил");
  });

  it("shows nothing while closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("WriteFailureAlert", () => {
  it("offers to load the data again after a stale write when the form can", () => {
    const onReload = vi.fn();
    render(<WriteFailureAlert failure={{ kind: "stale" }} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("explains a stale write without a reload button when the form cannot reload", () => {
    render(<WriteFailureAlert failure={{ kind: "stale" }} />);
    expect(
      screen.getByText("Данные изменились, пока вы их редактировали. Обновите их и повторите."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains any other failure by its text, and shows nothing without one", () => {
    const { rerender } = render(
      <WriteFailureAlert failure={{ kind: "alert", message: "errors.api.forbidden" }} />,
    );
    expect(screen.getByText("Недостаточно прав для этого действия.")).toBeTruthy();
    rerender(<WriteFailureAlert failure={null} />);
    expect(screen.queryByText("Недостаточно прав для этого действия.")).toBeNull();
  });
});

describe("office capabilities", () => {
  it("let administrators change reference data, and both roles the catalog (spec §4.8)", () => {
    expect(can("admin", "editReference")).toBe(true);
    expect(can("technologist", "editReference")).toBe(false);
    expect(can("admin", "editCatalog")).toBe(true);
    expect(can("technologist", "editCatalog")).toBe(true);
  });

  it("follow the signed-in user's role", () => {
    function Probe() {
      return <p>{useCan("editReference") ? "можно" : "нельзя"}</p>;
    }
    const { rerender } = render(
      <OfficeSessionProvider value={fakeOfficeSession()}>
        <Probe />
      </OfficeSessionProvider>,
    );
    expect(screen.getByText("можно")).toBeTruthy();
    rerender(
      <OfficeSessionProvider value={fakeOfficeSession({ user: TECHNOLOGIST })}>
        <Probe />
      </OfficeSessionProvider>,
    );
    expect(screen.getByText("нельзя")).toBeTruthy();
  });
});
```

2. Заменить содержимое `apps/standalone/test/form-errors.test.ts` целиком:

```ts
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { alertFailure, failureMessage, writeFailure } from "../src/office/form-errors.js";

const FIELDS = { name: "orgName", gln: "gln" } as const;

function conflict(constraint: unknown): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "another active line has this name",
    details: { constraint },
  });
}

function rejected(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "rejected",
    details: { field },
  });
}

describe("writeFailure", () => {
  it("puts a validation failure under the form field the host names", () => {
    const error = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "the GLN must be 13 digits",
      details: { field: "gln" },
    });
    expect(writeFailure(error, FIELDS)).toEqual({
      kind: "field",
      field: "gln",
      message: "rules.rejected",
    });
  });

  it("asks to reload after a stale write", () => {
    const error = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { currentRev: 9 },
    });
    expect(writeFailure(error, FIELDS)).toEqual({ kind: "stale" });
  });

  it("explains everything else by its code", () => {
    const unknownField = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "bad",
      details: { field: "somethingElse" },
    });
    expect(writeFailure(unknownField, FIELDS)).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    expect(writeFailure(down, FIELDS)).toEqual({
      kind: "alert",
      message: "errors.transport.unreachable",
    });
    expect(writeFailure(new Error("boom"), FIELDS)).toEqual({
      kind: "alert",
      message: "errors.unknown",
    });
  });

  it("puts a conflict the form knows under its field, with the form's own text", () => {
    const conflicts = { line_name: { field: "name", message: "office.lines.errors.nameTaken" } };
    expect(writeFailure(conflict("line_name"), { name: "name" }, conflicts)).toEqual({
      kind: "field",
      field: "name",
      message: "office.lines.errors.nameTaken",
    });
  });

  it("explains a conflict the form does not know by its code", () => {
    const conflicts = { line_name: { field: "name", message: "office.lines.errors.nameTaken" } };
    expect(writeFailure(conflict("login"), { name: "name" }, conflicts)).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(writeFailure(conflict(7), { name: "name" }, conflicts)).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(writeFailure(conflict("line_name"), { name: "name" })).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });

  it("gives a field its own text when the form names one", () => {
    const fields = {
      newPassword: { field: "newPassword", message: "rules.password" },
      name: "name",
    } as const;
    expect(writeFailure(rejected("newPassword"), fields)).toEqual({
      kind: "field",
      field: "newPassword",
      message: "rules.password",
    });
    expect(writeFailure(rejected("name"), fields)).toEqual({
      kind: "field",
      field: "name",
      message: "rules.rejected",
    });
  });

  it("never takes an inherited object key for a field or a constraint", () => {
    expect(writeFailure(rejected("constructor"), FIELDS)).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(writeFailure(conflict("toString"), FIELDS, {})).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });
});

describe("alertFailure", () => {
  it("explains a write that has no field to go under", () => {
    const stale = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { currentRev: 9 },
    });
    expect(alertFailure(stale)).toEqual({ kind: "stale" });
    expect(alertFailure(rejected("name"))).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(alertFailure(new Error("boom"))).toEqual({ kind: "alert", message: "errors.unknown" });
  });
});

describe("failureMessage", () => {
  it("shows the alert's own message", () => {
    expect(failureMessage({ kind: "alert", message: "errors.api.validation_failed" })).toBe(
      "errors.api.validation_failed",
    );
  });

  it("falls back to the stale-revision text for anything without a message", () => {
    expect(failureMessage({ kind: "stale" })).toBe("errors.api.stale_revision");
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts test/form-dialog.test.tsx test/users-page.test.tsx test/sscc-page.test.tsx test/office.test.tsx test/org-page.test.tsx`
Expected: FAIL — `Test Files 2 failed | 4 passed (6)`, `Tests 4 failed | 61 passed (65)`:

- `form-dialog.test.tsx` не собирается: `Failed to resolve import "../src/office/access.js"`;
- `form-errors.test.ts` — 4 теста из 10:
  - «puts a conflict the form knows under its field…» — `expected { kind: 'alert', …(1) } to deeply equal { kind: 'field', field: 'name', …(1) }`;
  - «gives a field its own text…» — объект `{ field, message }` попадает в `field` целиком;
  - «never takes an inherited object key…» — `field: [Function Object]`;
  - «explains a write that has no field to go under» — `alertFailure is not a function`;
- тесты страниц пользователей, SSCC, офиса и профиля проходят: их диалоги ещё прежние.

- [ ] **Step 3: Общие части и перевод диалогов**

1. Create `apps/standalone/src/office/FormDialog.tsx`:

```tsx
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, Modal } from "@markiro/ui";

export interface FormDialogProps {
  title: string;
  /** The submit button's text. */
  submitLabel: string;
  /** Keeps the submit button off, for example until something changed. */
  submitDisabled?: boolean;
  /** `destructive` for an action that cannot be undone. */
  submitVariant?: "primary" | "destructive";
  /** `false` hides a dialog that stays mounted between openings; open by default. */
  open?: boolean;
  /** Sends the form; the dialog waits until the promise settles. */
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onClose: () => void;
  /** Above the fields: a failed write (`WriteFailureAlert`), or nothing. */
  alert?: ReactNode;
  children: ReactNode;
}

/**
 * An office dialog around one form: the title, the fields, and a footer with
 * «Отмена» and the submit button, which the form owns through `form`. From
 * the submit until `onSubmit` settles, Escape, the overlay, the × and
 * «Отмена» do not close it and a second submit is dropped: a request in
 * flight is never abandoned or sent twice, and its error is not wiped from
 * under it.
 */
export function FormDialog({
  title,
  submitLabel,
  submitDisabled = false,
  submitVariant = "primary",
  open = true,
  onSubmit,
  onClose,
  alert,
  children,
}: FormDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  // Set at once, so a second submit or a close in the same moment is refused
  // before `sending` has re-rendered the buttons.
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    void onSubmit(event).finally(() => {
      inFlight.current = false;
      setSending(false);
    });
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={sending}>
            {t("office.common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={submitVariant}
            loading={sending}
            disabled={submitDisabled}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="standalone-form" onSubmit={send} noValidate>
        {alert}
        {children}
      </form>
    </Modal>
  );
}
```

2. Create `apps/standalone/src/office/access.ts`:

```ts
import type { OfficeRole } from "../host/protocol.js";
import { useOfficeSession } from "./office-session.js";

/**
 * What each office role may change (spec §4.8). The host enforces the same
 * table on every request; the office reads it to show a form or a read-only
 * view. Administrator-only pages (users, devices) are gated by `OFFICE_NAV`
 * and `RequireRole` instead.
 */
const CAPABILITIES = {
  /** The organization, SSCC counters, counterparties and lines; every role reads them. */
  editReference: ["admin"],
  /** The catalog, label templates and their defaults (plan 1e). */
  editCatalog: ["admin", "technologist"],
} as const satisfies Record<string, readonly OfficeRole[]>;

export type OfficeCapability = keyof typeof CAPABILITIES;

/** Whether `role` may do `capability`. */
export function can(role: OfficeRole, capability: OfficeCapability): boolean {
  const roles: readonly OfficeRole[] = CAPABILITIES[capability];
  return roles.includes(role);
}

/** Whether the signed-in user may do `capability`; follows a role changed mid-session. */
export function useCan(capability: OfficeCapability): boolean {
  return can(useOfficeSession().user.role, capability);
}
```

3. Заменить содержимое `apps/standalone/src/office/form-errors.ts` целиком:

```ts
import { useTranslation } from "react-i18next";

import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";

/** What a form shows for a failed write. Messages are i18n keys. */
export type WriteFailure<F extends string> =
  | { kind: "field"; field: F; message: string }
  | { kind: "stale" }
  | { kind: "alert"; message: string };

/** A failed write shown above the form rather than under a field (`WriteFailureAlert`). */
export type AlertFailure = Exclude<WriteFailure<string>, { kind: "field" }>;

/** A form field and the i18n key of the text it shows. */
export interface FieldMessage<F extends string> {
  field: F;
  message: string;
}

/** `record[key]` when `record` has that key of its own; never an inherited `Object` member. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Sorts a failed office write: a `validation_failed` naming a known field
 * goes under that field, a `conflict` whose `details.constraint` the form
 * knows goes under that constraint's field with the form's own text, and
 * the rest is `alertFailure`. `fields` maps the host's field names to the
 * form's; a bare field name says `rules.rejected`, a `FieldMessage` its own
 * text. `conflicts` maps constraint names (`line_name`, `login`, `badge`)
 * the same way.
 */
export function writeFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F | FieldMessage<F>>>,
  conflicts: Readonly<Record<string, FieldMessage<F>>> = {},
): WriteFailure<F> {
  if (error instanceof HostError) {
    const constraint = error.details.constraint;
    if (error.code === "conflict" && typeof constraint === "string") {
      const target = own(conflicts, constraint);
      if (target !== undefined) {
        return { kind: "field", field: target.field, message: target.message };
      }
    }
    const path = error.field;
    const target = path === null ? undefined : own(fields, path);
    if (typeof target === "string") {
      return { kind: "field", field: target, message: "rules.rejected" };
    }
    if (target !== undefined) {
      return { kind: "field", field: target.field, message: target.message };
    }
  }
  return alertFailure(error);
}

/**
 * A failed write with no field to go under, as a confirmation without fields
 * has: `stale_revision` offers to reload, anything else is explained by its
 * code.
 */
export function alertFailure(error: unknown): AlertFailure {
  if (error instanceof HostError && error.code === "stale_revision") return { kind: "stale" };
  return { kind: "alert", message: errorMessageKey(error) };
}

/** The alert text for a failure that is not a field error; a stale write reads as `stale_revision`. */
export function failureMessage(failure: AlertFailure): string {
  return failure.kind === "alert" ? failure.message : "errors.api.stale_revision";
}

/**
 * The `error` prop of a form control for a message key, translated with
 * `values`; no key, no prop (`exactOptionalPropertyTypes` rejects an
 * explicit `undefined`, as `errorProp` explains).
 */
export function useFieldError(): (
  message: string | undefined,
  values?: Record<string, unknown>,
) => { error?: string } {
  const { t } = useTranslation();
  return (message, values) => {
    if (message === undefined) return {};
    return { error: values === undefined ? t(message) : t(message, values) };
  };
}
```

4. В `apps/standalone/src/office/page-state.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Spinner } from "@markiro/ui";

import { errorMessageKey } from "../host/errors.js";

/** An office page while its data loads. */
export function PageLoading() {
```

заменить на

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Spinner } from "@markiro/ui";

import { errorMessageKey } from "../host/errors.js";
import { failureMessage, type AlertFailure } from "./form-errors.js";

/** An office page while its data loads. */
export function PageLoading() {
```

5. В `apps/standalone/src/office/page-state.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      {t("errors.api.stale_revision")}
    </Alert>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
      {t("errors.api.stale_revision")}
    </Alert>
  );
}

export interface WriteFailureAlertProps {
  /** `null` shows nothing. */
  failure: AlertFailure | null;
  /** Loads the data again after a stale write; without it a stale write is only explained. */
  onReload?: () => void;
}

/** A failed write above a form: a stale one offers to reload when the form can, the rest are explained. */
export function WriteFailureAlert({ failure, onReload }: WriteFailureAlertProps) {
  const { t } = useTranslation();
  if (failure === null) return null;
  if (failure.kind === "stale" && onReload !== undefined) return <StaleAlert onReload={onReload} />;
  return <Alert tone="error">{t(failureMessage(failure))}</Alert>;
}
```

6. Заменить содержимое `apps/standalone/src/office/users/CreateUserDialog.tsx` целиком:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { RoleRadios } from "./RoleRadios.js";
import { newUserSchema, type NewUserValues } from "./user-forms.js";

const CREATE_FIELDS = { login: "login", name: "name", role: "role", password: "password" } as const;
const CREATE_CONFLICTS = {
  login: { field: "login", message: "office.users.errors.loginTaken" },
} as const;

export interface CreateUserDialogProps {
  onClose: () => void;
  onCreated: (user: OfficeUserRecord) => void;
}

export function CreateUserDialog({ onClose, onCreated }: CreateUserDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const create = useOfficeMutation((api, token, values: NewUserValues) =>
    api.createUser(token, {
      login: values.login,
      name: values.name,
      role: values.role,
      password: values.password,
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<NewUserValues>({
    resolver: zodResolver(newUserSchema),
    defaultValues: { login: "", name: "", role: "technologist", password: "", confirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onCreated(await create.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, CREATE_FIELDS, CREATE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.users.createTitle")}
      submitLabel={t("office.users.create")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        label={t("office.users.fields.login")}
        hint={t("office.users.fields.loginHint")}
        autoComplete="off"
        mono
        {...fieldError(errors.login?.message)}
        {...register("login")}
      />
      <Input
        label={t("office.users.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Controller
        control={control}
        name="role"
        render={({ field }) => (
          <RoleRadios value={field.value} onChange={field.onChange} disabled={false} hint={null} />
        )}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.password")}
        hint={t("office.users.fields.passwordHint")}
        {...fieldError(errors.password?.message)}
        {...register("password")}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.confirm")}
        {...fieldError(errors.confirm?.message)}
        {...register("confirm")}
      />
    </FormDialog>
  );
}
```

7. Заменить содержимое `apps/standalone/src/office/users/EditUserDialog.tsx` целиком:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, Input } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { RoleRadios } from "./RoleRadios.js";
import { userEditSchema, type UserEditValues } from "./user-forms.js";

const EDIT_FIELDS = { name: "name", role: "role", active: "active" } as const;

export interface EditUserDialogProps {
  user: OfficeUserRecord;
  /** The signed-in administrator's own record: only the name can change. */
  own: boolean;
  onClose: () => void;
  onSaved: (user: OfficeUserRecord) => void;
  /** The record changed on the host: close and load the users again. */
  onReload: () => void;
}

export function EditUserDialog({ user, own, onClose, onSaved, onReload }: EditUserDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, values: UserEditValues) =>
    api.updateUser(token, user.id, {
      name: values.name,
      role: values.role,
      active: values.active,
      expectedRev: user.rev,
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<UserEditValues>({
    resolver: zodResolver(userEditSchema),
    defaultValues: { name: user.name, role: user.role, active: user.active },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, EDIT_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.users.editTitle", { login: user.login })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Input
        label={t("office.users.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Controller
        control={control}
        name="role"
        render={({ field }) => (
          <RoleRadios
            value={field.value}
            onChange={field.onChange}
            disabled={own}
            hint={own ? t("office.users.ownRoleHint") : null}
          />
        )}
      />
      <Controller
        control={control}
        name="active"
        render={({ field }) => (
          <Checkbox
            label={t("office.users.fields.active")}
            checked={field.value}
            onCheckedChange={field.onChange}
            disabled={own}
            {...(own ? { hint: t("office.users.ownAccessHint") } : {})}
          />
        )}
      />
    </FormDialog>
  );
}
```

8. Заменить содержимое `apps/standalone/src/office/users/SetPasswordDialog.tsx` целиком:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { passwordSetFormSchema, type PasswordSetValues } from "./user-forms.js";

const PASSWORD_FIELDS = { password: "password" } as const;

export interface SetPasswordDialogProps {
  user: OfficeUserRecord;
  onClose: () => void;
  onChanged: () => void;
}

/** An administrator sets someone else's password; the host ends that user's sessions. */
export function SetPasswordDialog({ user, onClose, onChanged }: SetPasswordDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const set = useOfficeMutation((api, token, password: string) =>
    api.setUserPassword(token, user.id, { password }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<PasswordSetValues>({
    resolver: zodResolver(passwordSetFormSchema),
    defaultValues: { password: "", confirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await set.mutateAsync(values.password);
      onChanged();
    } catch (error) {
      const outcome = writeFailure(error, PASSWORD_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.users.passwordTitle", { login: user.login })}
      submitLabel={t("office.users.passwordSubmit")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.users.passwordNote")}</p>
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.password")}
        hint={t("office.users.fields.passwordHint")}
        {...fieldError(errors.password?.message)}
        {...register("password")}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.confirm")}
        {...fieldError(errors.confirm?.message)}
        {...register("confirm")}
      />
    </FormDialog>
  );
}
```

9. Заменить содержимое `apps/standalone/src/office/ChangePasswordDialog.tsx` целиком:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import { HostError } from "../host/client.js";
import type { PasswordChange } from "../host/protocol.js";
import { passwordRule } from "../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "./form-errors.js";
import { FormDialog } from "./FormDialog.js";
import { useOfficeMutation } from "./office-query.js";
import { WriteFailureAlert } from "./page-state.js";

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "office.password.required"),
  newPassword: passwordRule,
  confirmPassword: z.string(),
});

type PasswordValues = z.infer<typeof passwordSchema>;

/** The host names the new password when it refuses it; the form says why in its own words. */
const PASSWORD_FIELDS = {
  newPassword: { field: "newPassword", message: "rules.password" },
} as const;

export interface ChangePasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function ChangePasswordDialog({ open, onClose, onChanged }: ChangePasswordDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const change = useOfficeMutation((api, token, request: PasswordChange) =>
    api.officeChangePassword(token, request),
  );
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  // The dialog stays mounted between openings: closing starts it afresh.
  const close = () => {
    reset();
    setFailure(null);
    onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    if (values.newPassword !== values.confirmPassword) {
      setError("confirmPassword", { type: "validate", message: "rules.passwordConfirm" });
      return;
    }
    try {
      await change.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset();
      onChanged();
    } catch (error) {
      if (error instanceof HostError && error.credential === "password") {
        setError("currentPassword", { type: "server", message: "office.password.wrongCurrent" });
        return;
      }
      const outcome = writeFailure(error, PASSWORD_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      open={open}
      title={t("office.password.title")}
      submitLabel={t("office.password.submit")}
      onSubmit={submit}
      onClose={close}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        type="password"
        autoComplete="current-password"
        label={t("office.password.current")}
        {...fieldError(errors.currentPassword?.message)}
        {...register("currentPassword")}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.password.new")}
        hint={t("office.password.hint")}
        {...fieldError(errors.newPassword?.message)}
        {...register("newPassword")}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.password.confirm")}
        {...fieldError(errors.confirmPassword?.message)}
        {...register("confirmPassword")}
      />
    </FormDialog>
  );
}
```

10. Заменить содержимое `apps/standalone/src/office/sscc/CounterDialog.tsx` целиком:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { SsccCounter } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { counterKindKey } from "./counter-kind.js";

const COUNTER_FIELDS = { nextSerial: "nextSerial" } as const;

interface CounterValues {
  nextSerial: number;
}

export interface CounterDialogProps {
  counter: SsccCounter;
  onClose: () => void;
  onSaved: (counter: SsccCounter) => void;
  /** The counter changed on the host: close and load the counters again. */
  onReload: () => void;
}

/** Moves one SSCC counter forward; it never goes back (spec §4.3). */
export function CounterDialog({ counter, onClose, onSaved, onReload }: CounterDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  // The smallest allowed value: the loaded counter, or the host's newer one.
  const [floor, setFloor] = useState(counter.nextSerial);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const schema = useMemo(
    () =>
      z.object({
        nextSerial: z
          .number({ error: "office.sscc.errors.range" })
          .int("office.sscc.errors.range")
          .min(floor, "office.sscc.errors.belowFloor")
          .max(counter.maxSerial, "office.sscc.errors.range"),
      }),
    [floor, counter.maxSerial],
  );
  const update = useOfficeMutation((api, token, nextSerial: number) =>
    api.updateSsccCounter(
      token,
      { issuerPrefix: counter.issuerPrefix, extension: counter.extension },
      { nextSerial, expectedRev: counter.rev },
    ),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<CounterValues>({
    resolver: zodResolver(schema),
    defaultValues: { nextSerial: counter.nextSerial },
  });
  const limits = { min: floor, max: counter.maxSerial };
  const kind = t(counterKindKey(counter), { extension: counter.extension });

  const submit = handleSubmit(async ({ nextSerial }) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(nextSerial));
    } catch (error) {
      if (error instanceof HostError && error.code === "sscc_below_floor") {
        const minSerial = error.details.minSerial;
        if (typeof minSerial === "number") setFloor(minSerial);
        setError("nextSerial", { type: "server", message: "office.sscc.errors.belowFloor" });
        return;
      }
      const outcome = writeFailure(error, COUNTER_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.sscc.counterDialog.title", { kind, prefix: counter.issuerPrefix })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.sscc.counterDialog.intro")}</p>
      <Input
        type="number"
        min={floor}
        max={counter.maxSerial}
        step={1}
        mono
        label={t("office.sscc.counterDialog.field")}
        hint={t("office.sscc.counterDialog.hint", limits)}
        {...fieldError(errors.nextSerial?.message, limits)}
        {...register("nextSerial", { valueAsNumber: true })}
      />
    </FormDialog>
  );
}
```

11. В `apps/standalone/src/office/sscc/BlockSizesForm.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import type { SsccState } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert } from "../page-state.js";

/** The host's limits (`put_block_sizes`): 1-100 000 box serials, 1-10 000 pallet serials. */
const blockSizesSchema = z.object({
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input } from "@markiro/ui";

import type { SsccState } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

/** The host's limits (`put_block_sizes`): 1-100 000 box serials, 1-10 000 pallet serials. */
const blockSizesSchema = z.object({
```

12. В `apps/standalone/src/office/sscc/BlockSizesForm.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
/** How many serials a station takes at a time; administrators only. */
export function BlockSizesForm({ state, onSaved, onSubmitStart, onReload }: BlockSizesFormProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, sizes: BlockSizes) =>
    api.updateBlockSizes(token, { ...sizes, expectedRev: state.blockSizesRev }),
  );
  const {
    register,
```

заменить на

<!-- prettier-ignore -->
```tsx
/** How many serials a station takes at a time; administrators only. */
export function BlockSizesForm({ state, onSaved, onSubmitStart, onReload }: BlockSizesFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, sizes: BlockSizes) =>
    api.updateBlockSizes(token, {
      boxBlockSize: sizes.boxBlockSize,
      palletBlockSize: sizes.palletBlockSize,
      expectedRev: state.blockSizesRev,
    }),
  );
  const {
    register,
```

13. В `apps/standalone/src/office/sscc/BlockSizesForm.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    resolver: zodResolver(blockSizesSchema),
    defaultValues: { boxBlockSize: state.boxBlockSize, palletBlockSize: state.palletBlockSize },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const submit = handleSubmit(async (sizes) => {
    onSubmitStart();
```

заменить на

<!-- prettier-ignore -->
```tsx
    resolver: zodResolver(blockSizesSchema),
    defaultValues: { boxBlockSize: state.boxBlockSize, palletBlockSize: state.palletBlockSize },
  });

  const submit = handleSubmit(async (sizes) => {
    onSubmitStart();
```

14. В `apps/standalone/src/office/sscc/BlockSizesForm.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
      {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
      <Input
        type="number"
        min={1}
```

заменить на

<!-- prettier-ignore -->
```tsx

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      <WriteFailureAlert failure={failure} onReload={onReload} />
      <Input
        type="number"
        min={1}
```

15. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
} from "@markiro/ui";

import type { SsccCounter, SsccState } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import { BlockSizesForm } from "./BlockSizesForm.js";
import { CounterDialog } from "./CounterDialog.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
} from "@markiro/ui";

import type { SsccCounter, SsccState } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { BlockSizesForm } from "./BlockSizesForm.js";
import { CounterDialog } from "./CounterDialog.js";
```

16. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

function SsccContent() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const queryClient = useQueryClient();
  const sscc = useOfficeQuery(officeKeys.sscc, (api, token) => api.getSscc(token));
  const [editing, setEditing] = useState<SsccCounter | null>(null);
```

заменить на

<!-- prettier-ignore -->
```tsx

function SsccContent() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const queryClient = useQueryClient();
  const sscc = useOfficeQuery(officeKeys.sscc, (api, token) => api.getSscc(token));
  const [editing, setEditing] = useState<SsccCounter | null>(null);
```

17. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  if (sscc.isError) return <LoadError error={sscc.error} onRetry={() => void sscc.refetch()} />;

  const state = sscc.data;
  const admin = user.role === "admin";
  const kindOf = (counter: SsccCounter) =>
    t(counterKindKey(counter), { extension: counter.extension });
  const columns: TableColumn<SsccCounter>[] = [
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (sscc.isError) return <LoadError error={sscc.error} onRetry={() => void sscc.refetch()} />;

  const state = sscc.data;
  const kindOf = (counter: SsccCounter) =>
    t(counterKindKey(counter), { extension: counter.extension });
  const columns: TableColumn<SsccCounter>[] = [
```

18. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      render: (counter) => String(counter.maxSerial),
    },
  ];
  if (admin) {
    columns.push({
      key: "actions",
      title: t("office.sscc.table.actions"),
```

заменить на

<!-- prettier-ignore -->
```tsx
      render: (counter) => String(counter.maxSerial),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.sscc.table.actions"),
```

19. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      <Card title={t("office.sscc.blocksTitle")} titleAs="h2">
        {saved === "blocks" && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        <p className="office-note">{t("office.sscc.blocksIntro")}</p>
        {admin ? (
          <BlockSizesForm
            key={state.blockSizesRev}
            state={state}
```

заменить на

<!-- prettier-ignore -->
```tsx
      <Card title={t("office.sscc.blocksTitle")} titleAs="h2">
        {saved === "blocks" && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        <p className="office-note">{t("office.sscc.blocksIntro")}</p>
        {canEdit ? (
          <BlockSizesForm
            key={state.blockSizesRev}
            state={state}
```

20. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          </>
        )}
      </Card>
      {admin && editing && (
        <CounterDialog
          counter={editing}
          onClose={() => setEditing(null)}
```

заменить на

<!-- prettier-ignore -->
```tsx
          </>
        )}
      </Card>
      {canEdit && editing && (
        <CounterDialog
          counter={editing}
          onClose={() => setEditing(null)}
```

21. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Combobox, DefinitionGrid, Input, PageHeader } from "@markiro/ui";

import type { OrgProfile } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import {
  issuerPrefix,
  ORG_HOST_FIELDS,
```

заменить на

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Combobox, DefinitionGrid, Input, PageHeader } from "@markiro/ui";

import type { OrgProfile } from "../../host/protocol.js";
import {
  issuerPrefix,
  ORG_HOST_FIELDS,
```

22. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  type OrgFields,
} from "../../lib/rules.js";
import { TIME_ZONE_OPTIONS } from "../../lib/time-zones.js";
import { writeFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading, StaleAlert } from "../page-state.js";

/** The organization profile (spec §5.5): administrators edit it, technologists read it. */
export function OrgProfilePage() {
```

заменить на

<!-- prettier-ignore -->
```tsx
  type OrgFields,
} from "../../lib/rules.js";
import { TIME_ZONE_OPTIONS } from "../../lib/time-zones.js";
import { useCan } from "../access.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";

/** The organization profile (spec §5.5): administrators edit it, technologists read it. */
export function OrgProfilePage() {
```

23. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

function OrgProfileContent() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const queryClient = useQueryClient();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  // The revision the last save produced; its notice stays until the data changes.
```

заменить на

<!-- prettier-ignore -->
```tsx

function OrgProfileContent() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const queryClient = useQueryClient();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  // The revision the last save produced; its notice stays until the data changes.
```

24. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  return (
    <Card>
      {savedRev === org.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {user.role === "admin" ? (
        // A new revision — after a save or a reload — starts the form afresh.
        <OrgProfileForm
          key={org.data.rev}
```

заменить на

<!-- prettier-ignore -->
```tsx
  return (
    <Card>
      {savedRev === org.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {canEdit ? (
        // A new revision — after a save or a reload — starts the form afresh.
        <OrgProfileForm
          key={org.data.rev}
```

25. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

function OrgProfileForm({ profile, onSaved, onSubmitStart, onReload }: OrgProfileFormProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, values: OrgFields) =>
    api.updateOrg(token, { ...toOrgInput(values), expectedRev: profile.rev }),
  );
```

заменить на

<!-- prettier-ignore -->
```tsx

function OrgProfileForm({ profile, onSaved, onSubmitStart, onReload }: OrgProfileFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, values: OrgFields) =>
    api.updateOrg(token, { ...toOrgInput(values), expectedRev: profile.rev }),
  );
```

26. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      timeZone: profile.timeZone,
    },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));
  const gln = useWatch({ control, name: "gln" }).trim();
  const newPrefix =
    THIRTEEN_DIGITS.test(gln) && issuerPrefix(gln) !== issuerPrefix(profile.gln)
```

заменить на

<!-- prettier-ignore -->
```tsx
      timeZone: profile.timeZone,
    },
  });
  const gln = useWatch({ control, name: "gln" }).trim();
  const newPrefix =
    THIRTEEN_DIGITS.test(gln) && issuerPrefix(gln) !== issuerPrefix(profile.gln)
```

27. В `apps/standalone/src/office/org/OrgProfilePage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
      {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
      <Input
        label={t("org.name")}
        {...fieldError(errors.orgName?.message)}
```

заменить на

<!-- prettier-ignore -->
```tsx

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      <WriteFailureAlert failure={failure} onReload={onReload} />
      <Input
        label={t("org.name")}
        {...fieldError(errors.orgName?.message)}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2.
Expected: PASS — 6 файлов, 76 тестов: 10 в `form-errors.test.ts`, 11 в `form-dialog.test.tsx`, 14 в `users-page.test.tsx`, 10 в `sscc-page.test.tsx`, 23 в `office.test.tsx`, 8 в `org-page.test.tsx`. Тесты страниц не менялись.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Office pages», фрагмент

<!-- prettier-ignore -->
```text
  never retries with `details.currentRev`.
- A success notice is an `Alert` on the page or dialog; it goes away when
  the next save starts (or the next dialog opens).
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

заменить на

<!-- prettier-ignore -->
```text
  never retries with `details.currentRev`.
- A success notice is an `Alert` on the page or dialog; it goes away when
  the next save starts (or the next dialog opens).
- A dialog around one form is a `FormDialog` (`src/office/FormDialog.tsx`):
  the title, the fields, «Отмена» and the submit button. From the submit
  until its promise settles it cannot be closed and a second submit is
  dropped, so a double click sends nothing twice. `writeFailure` (`src/office/form-errors.ts`)
  sorts a refused write: a `validation_failed` field or a `conflict`
  constraint the form names (`line_name`, `login`) goes under that field,
  `stale_revision` offers to reload, anything else is an alert
  (`WriteFailureAlert`). Whether a page shows a form or a read-only view comes
  from `useCan` (`src/office/access.ts`), the table of spec §4.8.
- Request bodies are built field by field, never spread from form values, so
  nothing the form holds reaches the host by accident; ids go into the path
  only.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 30 файлов, 547 тестов; `test/form-dialog.test.tsx` с `--reporter=verbose` — stderr пуст.

```bash
git add apps/standalone/src/office/FormDialog.tsx apps/standalone/src/office/access.ts apps/standalone/src/office/form-errors.ts apps/standalone/src/office/page-state.tsx apps/standalone/src/office/users/CreateUserDialog.tsx apps/standalone/src/office/users/EditUserDialog.tsx apps/standalone/src/office/users/SetPasswordDialog.tsx apps/standalone/src/office/ChangePasswordDialog.tsx apps/standalone/src/office/sscc/CounterDialog.tsx apps/standalone/src/office/sscc/BlockSizesForm.tsx apps/standalone/src/office/sscc/SsccPage.tsx apps/standalone/src/office/org/OrgProfilePage.tsx apps/standalone/test/form-errors.test.ts apps/standalone/test/form-dialog.test.tsx apps/standalone/AGENTS.md
git commit -m "feat(standalone): общая основа записи офиса — FormDialog, writeFailure с конфликтами, useCan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Правила полей как у хоста — `src/lib/rules.ts`

Хост с плана 1d2 отвергает в любом свободном тексте управляющие символы (`validate::clean_text`): NUL переживает `trim` и роняет проверку таблицы как 500, а NUL внутри имени даёт два одинаковых на вид активных названия. Формы пока считают только длину. Задача добавляет то же правило в `src/lib/rules.ts` и выносит правила полей компании из схемы организации, чтобы форма контрагента (задача 4) взяла их без копии. Правило свободного текста получают и прежние общие правила — имя человека, название организации, строки линий мастера — с прежними ключами и текстами.

**Files:**

- Modify: `apps/standalone/src/lib/rules.ts`, `apps/standalone/src/wizard/wizard-form.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/rules.test.ts`, `apps/standalone/test/wizard-form.test.ts`, `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: `characters(text)`, `THIRTEEN_DIGITS`, `parsePrefixList`, `hasValidCheckDigit` (`@markiro/domain`).
- Produces (`src/lib/rules.ts`):
  - `isPlainText(text: string, max: number): boolean`, `plainTextRule(max: number, message: string): z.ZodString`;
  - `personNameRule` (100, `rules.name`), `deviceNameRule` (100, `rules.name`), `lineNameRule` (100, `rules.lineName`), `companyNameRule` (200, `rules.orgName`);
  - `innRule`, `glnRule`, `gs1PrefixesRule`; `orgFieldsSchema` собран из них, поля и ключи прежние.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  isPlainText,
  lineNameRule,
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
```

2. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

describe("free text", () => {
  it("takes 1 to max characters, counted as the host counts them", () => {
    expect(isPlainText("Линия 1", 100)).toBe(true);
    expect(isPlainText("", 100)).toBe(false);
    expect(isPlainText("я".repeat(100), 100)).toBe(true);
    expect(isPlainText("я".repeat(101), 100)).toBe(false);
    // 100 emoji are 200 UTF-16 code units but 100 characters.
    expect(isPlainText("😀".repeat(100), 100)).toBe(true);
  });

  it("refuses a control character anywhere, as `char::is_control` does", () => {
    for (const control of ["\u0000", "\t", "\n", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect(isPlainText(`Линия${control}1`, 100)).toBe(false);
    }
    // Not control characters: a no-break space, a soft hyphen, a zero-width joiner.
    for (const text of ["Линия\u00a01", "Линия\u00ad1", "Линия\u200d1"]) {
      expect(isPlainText(text, 100)).toBe(true);
    }
  });

  it("trims before it counts, and a NUL at the edge is not trimmed away", () => {
    expect(lineNameRule.safeParse("  Линия 2  ").data).toBe("Линия 2");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("\u0000Линия").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("л".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("holds every free-text field the office and the wizard send", () => {
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe("rules.name");
    expect(deviceNameRule.safeParse(" Станция 2 ").data).toBe("Станция 2");
    expect(deviceNameRule.safeParse("Станция\u00002").error?.issues[0]?.message).toBe("rules.name");
    expect(companyNameRule.safeParse("я".repeat(201)).error?.issues[0]?.message).toBe(
      "rules.orgName",
    );
    expect(orgMessage({ orgName: "ООО\t«Атолл»" })).toBe("rules.orgName");
  });

  it("checks company fields with the organization's rules", () => {
    expect(innRule.safeParse(" 7812345678 ").data).toBe("7812345678");
    expect(innRule.safeParse("").success).toBe(true);
    expect(innRule.safeParse("781234567").error?.issues[0]?.message).toBe("rules.inn");
    expect(glnRule.safeParse("4601234000017").success).toBe(true);
    expect(glnRule.safeParse("4601234000010").error?.issues[0]?.message).toBe(
      "rules.glnCheckDigit",
    );
    expect(gs1PrefixesRule.safeParse("4601234, 4609876").success).toBe(true);
    expect(gs1PrefixesRule.safeParse("123").error?.issues[0]?.message).toBe("rules.gs1Prefixes");
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
```

3. В `apps/standalone/test/wizard-form.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(validateStep("lines", values({ lines: [{ name: " " }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `Линия ${index + 1}` }));
    expect(validateStep("lines", values({ lines: many }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lines" },
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(validateStep("lines", values({ lines: [{ name: " " }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    // A control character inside a name is refused like on the host.
    expect(validateStep("lines", values({ lines: [{ name: "Линия\t1" }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `Линия ${index + 1}` }));
    expect(validateStep("lines", values({ lines: many }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lines" },
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/wizard-form.test.ts`
Expected: FAIL — 6 тестов из 24:

- `rules.test.ts`, 5 из 17: `isPlainText is not a function`, `Cannot read properties of undefined (reading 'safeParse')` (`lineNameRule`, `innRule` ещё нет) и `expected undefined to be 'rules.name'` (`personNameRule` пропускает табуляцию);
- `wizard-form.test.ts`, 1 из 7: «check the lines, repeats ignoring case» — `expected [] to deeply equal [ { field: 'lines.0.name', …(1) } ]`.

- [ ] **Step 3: Правило свободного текста и правила полей компании**

1. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/** Characters as the host counts them (Unicode scalar values). */
export function characters(text: string): number {
  return [...text].length;
}

export const THIRTEEN_DIGITS = /^\d{13}$/;
```

заменить на

<!-- prettier-ignore -->
```ts
/** Characters as the host counts them (Unicode scalar values). */
export function characters(text: string): number {
  return [...text].length;
}

/** A control character (`char::is_control`: the C0 range, DEL and the C1 range). */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Free text as the host takes it (`validate::clean_text`, already trimmed
 * here): 1 to `max` characters, counted as the host counts them, with no
 * control character anywhere. A NUL or a tab survives `trim`, and the host
 * refuses both.
 */
export function isPlainText(text: string, max: number): boolean {
  const count = characters(text);
  return count >= 1 && count <= max && !CONTROL_CHARACTER.test(text);
}

/** A free-text field of 1 to `max` characters (`isPlainText`); the value is trimmed. */
export function plainTextRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => isPlainText(text, max), message);
}

export const THIRTEEN_DIGITS = /^\d{13}$/;
```

2. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  .regex(/^[A-Za-z0-9._-]{3,64}$/, "rules.login");

/** A person's display name (`validate::person_name`). */
export const personNameRule = z
  .string()
  .trim()
  .refine((name) => characters(name) >= 1 && characters(name) <= 100, "rules.name");

/** A password (`validate::password`). */
export const passwordRule = z
```

заменить на

<!-- prettier-ignore -->
```ts
  .regex(/^[A-Za-z0-9._-]{3,64}$/, "rules.login");

/** A person's display name (`validate::person_name`). */
export const personNameRule = plainTextRule(100, "rules.name");

/** A device's name (`validate::device_name`). */
export const deviceNameRule = plainTextRule(100, "rules.name");

/** A production line's name (`validate::line_name`). */
export const lineNameRule = plainTextRule(100, "rules.lineName");

/** The organization's or a counterparty's name (`validate::company`). */
export const companyNameRule = plainTextRule(200, "rules.orgName");

/** An INN: 10 or 12 digits, or empty for none (`validate::company`). */
export const innRule = z
  .string()
  .trim()
  .regex(/^(\d{10}|\d{12})?$/, "rules.inn");

/** A GLN: 13 digits (`validate::company`) with a valid GS1 check digit, which only the forms check. */
export const glnRule = z
  .string()
  .trim()
  .regex(THIRTEEN_DIGITS, "rules.gln")
  .refine((gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln), "rules.glnCheckDigit");

/** GS1 prefixes as one comma-separated string: at most 10 of 4-12 digits (`validate::company`). */
export const gs1PrefixesRule = z.string().refine(isValidPrefixList, "rules.gs1Prefixes");

/** A password (`validate::password`). */
export const passwordRule = z
```

3. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
  orgName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 200, "rules.orgName"),
  inn: z
    .string()
    .trim()
    .regex(/^(\d{10}|\d{12})?$/, "rules.inn"),
  gln: z
    .string()
    .trim()
    .regex(THIRTEEN_DIGITS, "rules.gln")
    .refine((gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln), "rules.glnCheckDigit"),
  gs1Prefixes: z.string().refine(isValidPrefixList, "rules.gs1Prefixes"),
  timeZone: z.string().min(1, "rules.timeZone"),
});
export type OrgFields = z.input<typeof orgFieldsSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
  orgName: companyNameRule,
  inn: innRule,
  gln: glnRule,
  gs1Prefixes: gs1PrefixesRule,
  timeZone: z.string().min(1, "rules.timeZone"),
});
export type OrgFields = z.input<typeof orgFieldsSchema>;
```

4. В `apps/standalone/src/wizard/wizard-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts

import type { BootstrapRequest } from "../host/protocol.js";
import {
  characters,
  issuerPrefix,
  loginRule,
  ORG_HOST_FIELDS,
```

заменить на

<!-- prettier-ignore -->
```ts

import type { BootstrapRequest } from "../host/protocol.js";
import {
  isPlainText,
  issuerPrefix,
  loginRule,
  ORG_HOST_FIELDS,
```

5. В `apps/standalone/src/wizard/wizard-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  lines.forEach((line, index) => {
    const name = line.name.trim();
    const field: WizardField = `lines.${index}.name`;
    if (characters(name) < 1 || characters(name) > 100) {
      issues.push({ field, message: "wizard.errors.lineName" });
      return;
    }
```

заменить на

<!-- prettier-ignore -->
```ts
  lines.forEach((line, index) => {
    const name = line.name.trim();
    const field: WizardField = `lines.${index}.name`;
    if (!isPlainText(name, 100)) {
      issues.push({ field, message: "wizard.errors.lineName" });
      return;
    }
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "password": "Пароль — от 8 до 128 символов",
    "passwordConfirm": "Пароли не совпадают",
    "orgName": "Укажите название, до 200 символов",
    "inn": "ИНН — 10 или 12 цифр",
    "gln": "GLN — 13 цифр",
    "glnCheckDigit": "Неверная контрольная цифра GLN",
```

заменить на

<!-- prettier-ignore -->
```json
    "password": "Пароль — от 8 до 128 символов",
    "passwordConfirm": "Пароли не совпадают",
    "orgName": "Укажите название, до 200 символов",
    "lineName": "Укажите название линии, до 100 символов",
    "inn": "ИНН — 10 или 12 цифр",
    "gln": "GLN — 13 цифр",
    "glnCheckDigit": "Неверная контрольная цифра GLN",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2.
Expected: PASS — 17 тестов в `rules.test.ts`, 7 в `wizard-form.test.ts` (24).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Writes», фрагмент

<!-- prettier-ignore -->
```text
  is not whitespace, so `str::trim` keeps it while SQLite's `length()` stops
  at it and a table `CHECK` fails (a 500 instead of `validation_failed`); a
  control character inside a name would let two names that look identical
  both be active. The office forms mirror this rule (plan 1d3).
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
```

заменить на

<!-- prettier-ignore -->
```text
  is not whitespace, so `str::trim` keeps it while SQLite's `length()` stops
  at it and a table `CHECK` fails (a 500 instead of `validation_failed`); a
  control character inside a name would let two names that look identical
  both be active. The webview's forms check the same rule before sending
  (`isPlainText` and `plainTextRule` in `src/lib/rules.ts`): the office forms,
  the wizard and the device name at pairing. JavaScript's `trim` differs from
  Rust's only at the edges (a NEL, U+0085, is refused rather than trimmed; a
  BOM, U+FEFF, is trimmed), so a form is never more lenient than the host.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 30 файлов, 552 теста.

```bash
git add apps/standalone/src/lib/rules.ts apps/standalone/src/wizard/wizard-form.ts apps/standalone/src/i18n/ru.json apps/standalone/test/rules.test.ts apps/standalone/test/wizard-form.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): формы проверяют свободный текст так же, как хост" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Схемы, сборщики тел и методы `HostApi` — `src/host/`

Фикстуры плана 1d2 для контрагентов, линий, правки устройства и запроса кода подключения закреплены тестами хоста, но в вебвью у них нет схем. Задача добавляет схемы Zod (ответы — нестрогие, тела — `.strict()`), по одному сборщику на каждое тело (`src/host/requests.ts`) и методы `HostApi` с их подделками в `test/support/office.tsx`. Тест протокола читает фикстуры по имени: каждая схема разбирает свою фикстуру, каждый сборщик собирает свою фикстуру точно. Страницы появятся в задачах 4–6.

Сборщик называет каждое поле, которое уходит на хост: форма может держать что угодно, но в тело попадает только названное. `lineUpdate` и `deviceUpdate` шлют только то, что отличается от загруженной записи; `deviceUpdate` шлёт линию только станции, как требует хост.

**Files:**

- Create: `apps/standalone/src/host/requests.ts`
- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`, `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: `HostClient.request(method, path, { body?, officeToken?, schema })` — `src/host/client.ts` (тело `undefined` уходит как `null`, и оболочка не шлёт тело вовсе); фикстуры `proto/fixtures/{counterparty-record,counterparty-create,counterparty-update,office-line,line-create,line-update,device-update,device-record,pairing-code,pairing-code-request}.json`.
- Produces:
  - схемы и типы в `src/host/protocol.ts`: `counterpartyRecordSchema`/`CounterpartyRecord`, `officeLineSchema`/`OfficeLine`, `counterpartyCreateSchema`/`CounterpartyCreate`, `counterpartyUpdateSchema`/`CounterpartyUpdate`, `lineCreateSchema`/`LineCreate`, `lineUpdateSchema`/`LineUpdate`, `deviceUpdateSchema`/`DeviceUpdate`, `pairingCodeRequestSchema`/`PairingCodeRequest`;
  - сборщики в `src/host/requests.ts`: `interface CompanyInput { name: string; inn: string | null; gln: string; gs1Prefixes: readonly string[] }`, `counterpartyCreate(company)`, `counterpartyUpdate(company, archived, expectedRev)`, `lineCreate(name)`, `interface LineChange { name: string; archived: boolean }`, `lineUpdate(line, next)`, `interface DeviceChange { name: string; lineId: string | null }`, `deviceUpdate(device, next)`, `pairingCodeRequest(replaces)`;
  - методы `HostApi`: `listCounterparties(token)`, `createCounterparty(token, create)`, `updateCounterparty(token, id, update)`, `listLines(token)`, `createLine(token, create)`, `updateLine(token, id, update)`, `updateDevice(token, id, update)`, `revokeDevice(token, id)`; `createPairingCode(token, request?)` — без `request` тела нет.

- [ ] **Step 1: Тесты (падающие)**

Подделка `fakeHostApi` получает новые методы сразу: каждый, который тест не подменил, отказывает «unexpected HostApi.… call».

1. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  credentialSchema,
  deviceInfoSchema,
  deviceRecordSchema,
  errorBodySchema,
  helloSchema,
  lineRecordSchema,
  officeLoginRequestSchema,
  officeSessionSchema,
  officeUserCreateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
  counterpartyUpdateSchema,
  credentialSchema,
  deviceInfoSchema,
  deviceRecordSchema,
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeSessionSchema,
  officeUserCreateSchema,
```

2. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  orgProfileSchema,
  orgProfileUpdateSchema,
  orgRecordSchema,
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  orgProfileSchema,
  orgProfileUpdateSchema,
  orgRecordSchema,
  pairingCodeRequestSchema,
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
```

3. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
// for browser asset bundling (see `vite:asset-import-meta-url`); under the
```

заменить на

<!-- prettier-ignore -->
```ts
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";
import {
  counterpartyCreate,
  counterpartyUpdate,
  deviceUpdate,
  lineCreate,
  lineUpdate,
  pairingCodeRequest,
} from "../src/host/requests.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
// for browser asset bundling (see `vite:asset-import-meta-url`); under the
```

4. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["error-unauthorized.json", errorBodySchema],
  ["pairing-code.json", pairingCodeSchema],
  ["changes-response.json", changesResponseSchema],
] as const;

const REQUESTS = [
```

заменить на

<!-- prettier-ignore -->
```ts
  ["error-unauthorized.json", errorBodySchema],
  ["pairing-code.json", pairingCodeSchema],
  ["changes-response.json", changesResponseSchema],
  ["counterparty-record.json", counterpartyRecordSchema],
  ["office-line.json", officeLineSchema],
] as const;

const REQUESTS = [
```

5. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
  ["password-change.json", passwordChangeSchema],
] as const;

function extended(name: string): Record<string, unknown> {
```

заменить на

<!-- prettier-ignore -->
```ts
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
  ["password-change.json", passwordChangeSchema],
  ["counterparty-create.json", counterpartyCreateSchema],
  ["counterparty-update.json", counterpartyUpdateSchema],
  ["line-create.json", lineCreateSchema],
  ["line-update.json", lineUpdateSchema],
  ["device-update.json", deviceUpdateSchema],
  ["pairing-code-request.json", pairingCodeRequestSchema],
] as const;

function extended(name: string): Record<string, unknown> {
```

6. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

// Every request body the office sends has one builder, which names each
// field (no spread from form values); each must produce its fixture exactly.
describe("request builders produce their fixtures exactly", () => {
  it("a counterparty to create and one to update", () => {
    expect(
      counterpartyCreate({
        name: "ООО «Северный берег»",
        inn: null,
        gln: "4601234000017",
        gs1Prefixes: ["4601234"],
      }),
    ).toStrictEqual(fixture("counterparty-create.json"));
    expect(
      counterpartyUpdate(
        {
          name: "ООО «Северный берег»",
          inn: "7812345678",
          gln: "4601234000017",
          gs1Prefixes: ["4601234", "4609876"],
        },
        true,
        12,
      ),
    ).toStrictEqual(fixture("counterparty-update.json"));
  });

  it("a line to create and one to archive", () => {
    const line = officeLineSchema.parse(fixture("office-line.json"));
    expect(lineCreate("Линия 3")).toStrictEqual(fixture("line-create.json"));
    expect(lineUpdate(line, { name: line.name, archived: true })).toStrictEqual(
      fixture("line-update.json"),
    );
  });

  it("a station renamed and taken off its line", () => {
    const device = deviceRecordSchema.parse(fixture("device-record.json"));
    expect(deviceUpdate(device, { name: "Станция упаковки", lineId: null })).toStrictEqual(
      fixture("device-update.json"),
    );
  });

  it("a new pairing code that replaces the one on screen", () => {
    const code = pairingCodeSchema.parse(fixture("pairing-code.json"));
    expect(pairingCodeRequest(code.id)).toStrictEqual(fixture("pairing-code-request.json"));
  });
});

describe("request builders send only what changes", () => {
  const LINE = { name: "Линия 2", archived: false, rev: 40 };
  const STATION = {
    kind: "station",
    name: "Станция на линии 2",
    lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  } as const;

  it("names only the line fields that differ from the loaded line", () => {
    expect(lineUpdate(LINE, { name: "Линия 2", archived: false })).toStrictEqual({
      expectedRev: 40,
    });
    expect(lineUpdate(LINE, { name: "Линия 2а", archived: false })).toStrictEqual({
      name: "Линия 2а",
      expectedRev: 40,
    });
    expect(
      lineUpdate({ ...LINE, archived: true }, { name: "Линия 5", archived: false }),
    ).toStrictEqual({ name: "Линия 5", archived: false, expectedRev: 40 });
  });

  it("names only the device fields that differ, and a line only for a station", () => {
    expect(
      deviceUpdate(STATION, { name: "Станция на линии 2", lineId: STATION.lineId }),
    ).toStrictEqual({});
    expect(deviceUpdate(STATION, { name: "Упаковка", lineId: STATION.lineId })).toStrictEqual({
      name: "Упаковка",
    });
    const other = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    expect(deviceUpdate(STATION, { name: STATION.name, lineId: other })).toStrictEqual({
      lineId: other,
    });
    expect(
      deviceUpdate({ kind: "office", name: "Офис", lineId: null }, { name: "Офис", lineId: other }),
    ).toStrictEqual({});
  });

  it("copies the prefix list rather than handing over the caller's array", () => {
    const gs1Prefixes = ["4601234"];
    const body = counterpartyCreate({
      name: "ООО «Юг»",
      inn: null,
      gln: "4601234000017",
      gs1Prefixes,
    });
    gs1Prefixes.push("4609876");
    expect(body.gs1Prefixes).toEqual(["4601234"]);
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
```

7. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import { orgProfileUpdateSchema } from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
```

заменить на

<!-- prettier-ignore -->
```ts

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import {
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  lineUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
} from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
```

8. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
const TOKEN = "office-session-token";
const USER_ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const ORG_UPDATE = orgProfileUpdateSchema.parse(fixture("org-profile-update.json"));

type Case = [
  name: string,
```

заменить на

<!-- prettier-ignore -->
```ts
const TOKEN = "office-session-token";
const USER_ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const ORG_UPDATE = orgProfileUpdateSchema.parse(fixture("org-profile-update.json"));
const COUNTERPARTY_ID = "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e";
const LINE_ID = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const DEVICE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const COUNTERPARTY_CREATE = counterpartyCreateSchema.parse(fixture("counterparty-create.json"));
const COUNTERPARTY_UPDATE = counterpartyUpdateSchema.parse(fixture("counterparty-update.json"));
const LINE_UPDATE = lineUpdateSchema.parse(fixture("line-update.json"));
const DEVICE_UPDATE = deviceUpdateSchema.parse(fixture("device-update.json"));
const PAIRING_CODE_REQUEST = pairingCodeRequestSchema.parse(fixture("pairing-code-request.json"));

type Case = [
  name: string,
```

9. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    { method: "POST", path: "/v1/office/pairing-codes", body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "POST", path: "/v1/office/pairing-codes", body: undefined },
  ],
  [
    "createPairingCode replacing the code on screen",
    fixture("pairing-code.json"),
    (api) => api.createPairingCode(TOKEN, PAIRING_CODE_REQUEST),
    { method: "POST", path: "/v1/office/pairing-codes", body: PAIRING_CODE_REQUEST },
  ],
  [
    "updateDevice",
    fixture("device-record.json"),
    (api) => api.updateDevice(TOKEN, DEVICE_ID, DEVICE_UPDATE),
    { method: "PUT", path: `/v1/office/devices/${DEVICE_ID}`, body: DEVICE_UPDATE },
  ],
  [
    "revokeDevice",
    fixture("device-record.json"),
    (api) => api.revokeDevice(TOKEN, DEVICE_ID),
    { method: "POST", path: `/v1/office/devices/${DEVICE_ID}/revoke`, body: undefined },
  ],
  [
    "listCounterparties",
    [fixture("counterparty-record.json")],
    (api) => api.listCounterparties(TOKEN),
    { method: "GET", path: "/v1/office/counterparties", body: undefined },
  ],
  [
    "createCounterparty",
    fixture("counterparty-record.json"),
    (api) => api.createCounterparty(TOKEN, COUNTERPARTY_CREATE),
    { method: "POST", path: "/v1/office/counterparties", body: COUNTERPARTY_CREATE },
  ],
  [
    "updateCounterparty",
    fixture("counterparty-record.json"),
    (api) => api.updateCounterparty(TOKEN, COUNTERPARTY_ID, COUNTERPARTY_UPDATE),
    {
      method: "PUT",
      path: `/v1/office/counterparties/${COUNTERPARTY_ID}`,
      body: COUNTERPARTY_UPDATE,
    },
  ],
  [
    "listLines",
    [fixture("office-line.json")],
    (api) => api.listLines(TOKEN),
    { method: "GET", path: "/v1/office/lines", body: undefined },
  ],
  [
    "createLine",
    fixture("office-line.json"),
    (api) => api.createLine(TOKEN, { name: "Линия 3" }),
    { method: "POST", path: "/v1/office/lines", body: { name: "Линия 3" } },
  ],
  [
    "updateLine",
    fixture("office-line.json"),
    (api) => api.updateLine(TOKEN, LINE_ID, LINE_UPDATE),
    { method: "PUT", path: `/v1/office/lines/${LINE_ID}`, body: LINE_UPDATE },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

10. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
    getChanges: vi.fn<HostApi["getChanges"]>(() => unexpected("getChanges")),
    listDevices: vi.fn<HostApi["listDevices"]>(() => unexpected("listDevices")),
    createPairingCode: vi.fn<HostApi["createPairingCode"]>(() => unexpected("createPairingCode")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
    getChanges: vi.fn<HostApi["getChanges"]>(() => unexpected("getChanges")),
    listDevices: vi.fn<HostApi["listDevices"]>(() => unexpected("listDevices")),
    updateDevice: vi.fn<HostApi["updateDevice"]>(() => unexpected("updateDevice")),
    revokeDevice: vi.fn<HostApi["revokeDevice"]>(() => unexpected("revokeDevice")),
    createPairingCode: vi.fn<HostApi["createPairingCode"]>(() => unexpected("createPairingCode")),
    listCounterparties: vi.fn<HostApi["listCounterparties"]>(() =>
      unexpected("listCounterparties"),
    ),
    createCounterparty: vi.fn<HostApi["createCounterparty"]>(() =>
      unexpected("createCounterparty"),
    ),
    updateCounterparty: vi.fn<HostApi["updateCounterparty"]>(() =>
      unexpected("updateCounterparty"),
    ),
    listLines: vi.fn<HostApi["listLines"]>(() => unexpected("listLines")),
    createLine: vi.fn<HostApi["createLine"]>(() => unexpected("createLine")),
    updateLine: vi.fn<HostApi["updateLine"]>(() => unexpected("updateLine")),
    ...overrides,
  };
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
Expected: FAIL — оба файла не загружаются, `Tests no tests`:

- `protocol.test.ts` — `Failed to resolve import "../src/host/requests.js"`;
- `api.test.ts` — `TypeError: Cannot read properties of undefined (reading 'parse')`: схем новых тел ещё нет.

- [ ] **Step 3: Схемы, сборщики и методы**

1. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});
export type OfficeUserRecord = z.infer<typeof officeUserRecordSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type OfficeUserRecord = z.infer<typeof officeUserRecordSchema>;

/** `GET /v1/office/counterparties`: a customer of contract manufacturing; archived instead of deleted. */
export const counterpartyRecordSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  archived: z.boolean(),
  rev: z.number().int(),
});
export type CounterpartyRecord = z.infer<typeof counterpartyRecordSchema>;

/** `GET /v1/office/lines`: a production line as the office sees it, archived ones included. */
export const officeLineSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  archived: z.boolean(),
  rev: z.number().int(),
});
export type OfficeLine = z.infer<typeof officeLineSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

2. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  .object({ currentPassword: z.string(), newPassword: z.string() })
  .strict();
export type PasswordChange = z.infer<typeof passwordChangeSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
  .object({ currentPassword: z.string(), newPassword: z.string() })
  .strict();
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

/** `POST /v1/office/counterparties`; the office always sends `inn`, `null` for none. */
export const counterpartyCreateSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
  })
  .strict();
export type CounterpartyCreate = z.infer<typeof counterpartyCreateSchema>;

/** `PUT /v1/office/counterparties/{id}`: the whole record, `archived` included. */
export const counterpartyUpdateSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type CounterpartyUpdate = z.infer<typeof counterpartyUpdateSchema>;

/** `POST /v1/office/lines`. */
export const lineCreateSchema = z.object({ name: z.string() }).strict();
export type LineCreate = z.infer<typeof lineCreateSchema>;

/** `PUT /v1/office/lines/{id}`: only the fields sent change. */
export const lineUpdateSchema = z
  .object({
    name: z.string().optional(),
    archived: z.boolean().optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type LineUpdate = z.infer<typeof lineUpdateSchema>;

/** `PUT /v1/office/devices/{id}`: only the fields sent change; `lineId: null` clears the line. */
export const deviceUpdateSchema = z
  .object({ name: z.string().optional(), lineId: z.uuid().nullable().optional() })
  .strict();
export type DeviceUpdate = z.infer<typeof deviceUpdateSchema>;

/** The optional body of `POST /v1/office/pairing-codes`: the code «Новый код» replaces. */
export const pairingCodeRequestSchema = z.object({ replaces: z.uuid().optional() }).strict();
export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>;
```

3. Create `apps/standalone/src/host/requests.ts`:

```ts
import type {
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
  DeviceUpdate,
  LineCreate,
  LineUpdate,
  OfficeLine,
  PairingCodeRequest,
} from "./protocol.js";

// The office's request bodies, each built field by field and never spread
// from form values: a field reaches the host only when its builder names it,
// so nothing else a form holds is sent by accident. `test/protocol.test.ts`
// pins every builder's output against its fixture in `proto/fixtures`.

/** A company's fields, trimmed and normalized from a form (`toCompanyInput`). */
export interface CompanyInput {
  name: string;
  inn: string | null;
  gln: string;
  gs1Prefixes: readonly string[];
}

/** `POST /v1/office/counterparties` (`counterparty-create.json`). */
export function counterpartyCreate(company: CompanyInput): CounterpartyCreate {
  return {
    name: company.name,
    inn: company.inn,
    gln: company.gln,
    gs1Prefixes: [...company.gs1Prefixes],
  };
}

/**
 * `PUT /v1/office/counterparties/{id}` (`counterparty-update.json`): the
 * whole record with the loaded revision; `inn: null` clears the INN.
 */
export function counterpartyUpdate(
  company: CompanyInput,
  archived: boolean,
  expectedRev: number,
): CounterpartyUpdate {
  return {
    name: company.name,
    inn: company.inn,
    gln: company.gln,
    gs1Prefixes: [...company.gs1Prefixes],
    archived,
    expectedRev,
  };
}

/** `POST /v1/office/lines` (`line-create.json`). */
export function lineCreate(name: string): LineCreate {
  return { name };
}

/** What a line is to become; `lineUpdate` sends what differs from the loaded line. */
export interface LineChange {
  name: string;
  archived: boolean;
}

/**
 * `PUT /v1/office/lines/{id}` (`line-update.json`): only the fields that
 * change, with the loaded revision.
 */
export function lineUpdate(
  line: Pick<OfficeLine, "name" | "archived" | "rev">,
  next: LineChange,
): LineUpdate {
  const update: LineUpdate = { expectedRev: line.rev };
  if (next.name !== line.name) update.name = next.name;
  if (next.archived !== line.archived) update.archived = next.archived;
  return update;
}

/** What a device is to become: its name and, for a station, its line (`null` for none). */
export interface DeviceChange {
  name: string;
  lineId: string | null;
}

/**
 * `PUT /v1/office/devices/{id}` (`device-update.json`): only the fields that
 * change. Only a station has a line, so a line goes only with a station's
 * update; `lineId: null` clears it.
 */
export function deviceUpdate(
  device: Pick<DeviceRecord, "kind" | "name" | "lineId">,
  next: DeviceChange,
): DeviceUpdate {
  const update: DeviceUpdate = {};
  if (next.name !== device.name) update.name = next.name;
  if (device.kind === "station" && next.lineId !== device.lineId) update.lineId = next.lineId;
  return update;
}

/**
 * The body of «Новый код» (`pairing-code-request.json`): the code on screen,
 * which the host ends at once when the same administrator created it.
 */
export function pairingCodeRequest(replaces: string): PairingCodeRequest {
  return { replaces };
}
```

4. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import {
  bootstrapResponseSchema,
  changesResponseSchema,
  deviceRecordSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  officeLineSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
```

5. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type BootstrapRequest,
  type BootstrapResponse,
  type ChangesResponse,
  type DeviceRecord,
  type OfficeLoginRequest,
  type OfficeSession,
  type OfficeUser,
```

заменить на

<!-- prettier-ignore -->
```ts
  type BootstrapRequest,
  type BootstrapResponse,
  type ChangesResponse,
  type CounterpartyCreate,
  type CounterpartyRecord,
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceUpdate,
  type LineCreate,
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeSession,
  type OfficeUser,
```

6. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type OrgProfile,
  type OrgProfileUpdate,
  type PairingCode,
  type PasswordChange,
  type PasswordSet,
  type SsccCounter,
```

заменить на

<!-- prettier-ignore -->
```ts
  type OrgProfile,
  type OrgProfileUpdate,
  type PairingCode,
  type PairingCodeRequest,
  type PasswordChange,
  type PasswordSet,
  type SsccCounter,
```

7. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  /** Reference records changed after revision `since`; the device key only, no office session. */
  getChanges: (since: number) => Promise<ChangesResponse>;
  listDevices: (token: string) => Promise<DeviceRecord[]>;
  createPairingCode: (token: string) => Promise<PairingCode>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  /** Reference records changed after revision `since`; the device key only, no office session. */
  getChanges: (since: number) => Promise<ChangesResponse>;
  listDevices: (token: string) => Promise<DeviceRecord[]>;
  updateDevice: (token: string, id: string, update: DeviceUpdate) => Promise<DeviceRecord>;
  revokeDevice: (token: string, id: string) => Promise<DeviceRecord>;
  /** Without `request` no body is sent; with it, the code it names ends at once. */
  createPairingCode: (token: string, request?: PairingCodeRequest) => Promise<PairingCode>;
  listCounterparties: (token: string) => Promise<CounterpartyRecord[]>;
  createCounterparty: (token: string, create: CounterpartyCreate) => Promise<CounterpartyRecord>;
  updateCounterparty: (
    token: string,
    id: string,
    update: CounterpartyUpdate,
  ) => Promise<CounterpartyRecord>;
  listLines: (token: string) => Promise<OfficeLine[]>;
  createLine: (token: string, create: LineCreate) => Promise<OfficeLine>;
  updateLine: (token: string, id: string, update: LineUpdate) => Promise<OfficeLine>;
}

/** A 204 answer parses as `null`. */
```

8. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: z.array(deviceRecordSchema),
      }),
    createPairingCode: (token) =>
      client.request("POST", "/v1/office/pairing-codes", {
        officeToken: token,
        schema: pairingCodeSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: z.array(deviceRecordSchema),
      }),
    updateDevice: (token, id, update) =>
      client.request("PUT", `/v1/office/devices/${id}`, {
        body: update,
        officeToken: token,
        schema: deviceRecordSchema,
      }),
    revokeDevice: (token, id) =>
      client.request("POST", `/v1/office/devices/${id}/revoke`, {
        officeToken: token,
        schema: deviceRecordSchema,
      }),
    createPairingCode: (token, request) =>
      client.request("POST", "/v1/office/pairing-codes", {
        body: request,
        officeToken: token,
        schema: pairingCodeSchema,
      }),
    listCounterparties: (token) =>
      client.request("GET", "/v1/office/counterparties", {
        officeToken: token,
        schema: z.array(counterpartyRecordSchema),
      }),
    createCounterparty: (token, create) =>
      client.request("POST", "/v1/office/counterparties", {
        body: create,
        officeToken: token,
        schema: counterpartyRecordSchema,
      }),
    updateCounterparty: (token, id, update) =>
      client.request("PUT", `/v1/office/counterparties/${id}`, {
        body: update,
        officeToken: token,
        schema: counterpartyRecordSchema,
      }),
    listLines: (token) =>
      client.request("GET", "/v1/office/lines", {
        officeToken: token,
        schema: z.array(officeLineSchema),
      }),
    createLine: (token, create) =>
      client.request("POST", "/v1/office/lines", {
        body: create,
        officeToken: token,
        schema: officeLineSchema,
      }),
    updateLine: (token, id, update) =>
      client.request("PUT", `/v1/office/lines/${id}`, {
        body: update,
        officeToken: token,
        schema: officeLineSchema,
      }),
  };
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2.
Expected: PASS — 71 тест в `protocol.test.ts`, 24 в `api.test.ts` (95).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Protocol», фрагмент

<!-- prettier-ignore -->
```text

Changing a wire shape means changing `proto`, the Zod schemas and the
fixtures together; the Rust tests parse every fixture, and the Vitest suite
parses every fixture whose shape crosses the IPC boundary. Raise
`PROTOCOL_VERSION` for an incompatible change; the host keeps accepting the
previous version. Response types, which devices of different versions read,
tolerate unknown fields; request types, which the host parses, reject them
```

заменить на

<!-- prettier-ignore -->
```text

Changing a wire shape means changing `proto`, the Zod schemas and the
fixtures together; the Rust tests parse every fixture, and the Vitest suite
parses every fixture whose shape crosses the IPC boundary. An office request
body the webview builds has one builder in `src/host/requests.ts`, which
names every field it sends; `test/protocol.test.ts` checks that each builder
produces its fixture exactly. Raise
`PROTOCOL_VERSION` for an incompatible change; the host keeps accepting the
previous version. Response types, which devices of different versions read,
tolerate unknown fields; request types, which the host parses, reject them
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 30 файлов, 584 теста.

```bash
git add apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx apps/standalone/AGENTS.md
git commit -m "feat(standalone): схемы, сборщики тел и HostApi для контрагентов, линий, устройств и кодов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Страница «Контрагенты» — `src/office/counterparties/`

Контрагенты — заказчики контрактного производства (спецификация §4.3). Хост хранит их с плана 1d2: `GET` для всех ролей, `POST` и `PUT` с `expectedRev` для администратора, `PUT` берёт запись целиком (`inn: null` снимает ИНН), архив — `archived: true`, удаления нет, уникальности нет. Страница показывает список с естественной сортировкой, администратор добавляет и меняет контрагента одним диалогом, архив — флажок «В архиве» в том же диалоге. Технолог видит список только для чтения.

Уникальности контрагентов на хосте нет (вопрос владельцу открыт), поэтому форма дубликаты не ищет. Двойной щелчок по «Добавить» отправляет один запрос: это обеспечивает `FormDialog` из задачи 1.

`src/office/records.tsx` — общие части списков с архивом, которые берут и линии, и устройства: `activeFirstByName` (естественная сортировка, действующие раньше архивных), `withRecord` и `useStoreRecord` (сохранённая запись встаёт в кэш списка, без списка — список перечитывается), `ArchiveStatus` (состояние словом, `StatusChip`).

**Files:**

- Create: `apps/standalone/src/office/records.tsx`, `apps/standalone/src/office/counterparties/{counterparty-form.ts,CounterpartyDialog.tsx,CounterpartiesPage.tsx}`, `apps/standalone/test/counterparties-page.test.tsx`
- Modify: `apps/standalone/src/office/{office-query.ts,nav.ts,routes.tsx}`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes:
  - `FormDialog`, `writeFailure`, `useFieldError`, `WriteFailureAlert`, `useCan("editReference")` — задача 1;
  - `companyNameRule`, `innRule`, `glnRule`, `gs1PrefixesRule`, `parsePrefixList` — задача 2;
  - `CounterpartyRecord`, `CompanyInput`, `counterpartyCreate`, `counterpartyUpdate`, `HostApi.listCounterparties/createCounterparty/updateCounterparty` — задача 3.
- Produces:
  - `officeKeys.counterparties = ["office", "counterparties"]`;
  - `activeFirstByName<T extends ArchivableRecord>(records): T[]`, `withRecord(records, record)`, `useStoreRecord<T>(key): (record: T) => void`, `ArchiveStatus({ archived })` — `src/office/records.tsx`;
  - `counterpartyFieldsSchema`, `CounterpartyFields`, `COUNTERPARTY_FIELDS`, `counterpartyFields(record | null)`, `toCompanyInput(values): CompanyInput`;
  - `CounterpartyDialog({ counterparty: CounterpartyRecord | null, onClose, onSaved, onReload })`, `CounterpartiesPage()`; маршрут `/counterparties`, пункт меню «Контрагенты».

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/counterparties-page.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { CounterpartyRecord } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const NORTH: CounterpartyRecord = {
  id: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  name: "ООО «Северный берег»",
  inn: "7812345678",
  gln: "4601234000017",
  gs1Prefixes: ["4601234"],
  archived: false,
  rev: 12,
};
const PLANT_2: CounterpartyRecord = {
  id: "3a7f2c1e-9b4d-4e6f-8a1b-2c3d4e5f6a7b",
  name: "Завод 2",
  inn: null,
  gln: "4605555000015",
  gs1Prefixes: [],
  archived: false,
  rev: 3,
};
const PLANT_10: CounterpartyRecord = {
  id: "8e1d4c7b-2a5f-4b3e-9c6d-7f8a9b0c1d2e",
  name: "Завод 10",
  inn: "781234567890",
  gln: "4602222000026",
  gs1Prefixes: ["4602222", "4603333"],
  archived: false,
  rev: 4,
};
const OLD: CounterpartyRecord = {
  id: "5c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Альфа",
  inn: "7701234567",
  gln: "4603333000035",
  gs1Prefixes: [],
  archived: true,
  rev: 7,
};

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  // The host's own order (archived last, names bytewise): the page sorts again.
  session.api.listCounterparties.mockResolvedValue([PLANT_10, PLANT_2, NORTH, OLD]);
  return session;
}

async function openCounterparties(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Контрагенты" }));
  await screen.findByText("ООО «Северный берег»");
}

/** The names column, top to bottom. */
function names(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("office counterparties", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for both roles", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    expect(await screen.findByRole("link", { name: "Контрагенты" })).toBeTruthy();
  });

  it("lists the counterparties by name, numbers in order, archived ones last", async () => {
    await openCounterparties(adminSession());
    expect(names()).toEqual(["Завод 2", "Завод 10", "ООО «Северный берег»", "Альфа"]);
    const plant = rowOf("Завод 10");
    expect(within(plant).getByText("781234567890")).toBeTruthy();
    expect(within(plant).getByText("4602222, 4603333")).toBeTruthy();
    expect(within(plant).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Завод 2")).getAllByText("—")).toHaveLength(2);
    expect(within(rowOf("Альфа")).getByText("В архиве")).toBeTruthy();
  });

  it("shows a technologist the list without a way to change it", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.listCounterparties.mockResolvedValue([NORTH]);
    await openCounterparties(session);
    expect(screen.queryByRole("button", { name: "Добавить контрагента" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Изменить/ })).toBeNull();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("adds a counterparty, sending each field by name", async () => {
    const session = adminSession();
    const created: CounterpartyRecord = {
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      name: "ООО «Юг»",
      inn: null,
      gln: "4607091000009",
      gs1Prefixes: ["4607091", "4609876"],
      archived: false,
      rev: 20,
    };
    session.api.createCounterparty.mockResolvedValue(created);
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    type("Название", " ООО «Юг» ");
    type("GLN контрагента", "4607091000009");
    type("Префиксы GS1", "4607091, 4607091; 4609876");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Контрагент «ООО «Юг»» добавлен.")).toBeTruthy();
    expect(session.api.createCounterparty.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          name: "ООО «Юг»",
          inn: null,
          gln: "4607091000009",
          gs1Prefixes: ["4607091", "4609876"],
        },
      ],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual(["Завод 2", "Завод 10", "ООО «Северный берег»", "ООО «Юг»", "Альфа"]);
  });

  it("checks the fields like the host, and the GLN check digit, before sending", async () => {
    const session = adminSession();
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    type("Название", "ООО\t«Юг»");
    type("ИНН", "781234567");
    type("GLN контрагента", "4607091000000");
    type("Префиксы GS1", "123");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Укажите название, до 200 символов")).toBeTruthy();
    expect(screen.getByText("ИНН — 10 или 12 цифр")).toBeTruthy();
    expect(screen.getByText("Неверная контрольная цифра GLN")).toBeTruthy();
    expect(
      screen.getByText("Каждый префикс — от 4 до 12 цифр, не больше 10 префиксов"),
    ).toBeTruthy();
    expect(session.api.createCounterparty).not.toHaveBeenCalled();
  });

  it("saves a change as the whole record with the loaded revision, archive included", async () => {
    const session = adminSession();
    session.api.updateCounterparty.mockResolvedValue({
      ...NORTH,
      name: "ООО «Северный берег-2»",
      archived: true,
      rev: 21,
    });
    await openCounterparties(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить контрагента «ООО «Северный берег»»" }),
    );
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Название", "ООО «Северный берег-2»");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateCounterparty.mock.calls).toStrictEqual([
      [
        "office-session-token",
        NORTH.id,
        {
          name: "ООО «Северный берег-2»",
          inn: "7812345678",
          gln: "4601234000017",
          gs1Prefixes: ["4601234"],
          archived: true,
          expectedRev: 12,
        },
      ],
    ]);
    expect(names()).toEqual(["Завод 2", "Завод 10", "Альфа", "ООО «Северный берег-2»"]);
    expect(within(rowOf("ООО «Северный берег-2»")).getByText("В архиве")).toBeTruthy();
  });

  it("clears the INN with null and takes a counterparty out of the archive", async () => {
    const session = adminSession();
    session.api.updateCounterparty.mockResolvedValue({
      ...OLD,
      inn: null,
      archived: false,
      rev: 22,
    });
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить контрагента «Альфа»" }));
    type("ИНН", " ");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateCounterparty).toHaveBeenCalledWith("office-session-token", OLD.id, {
      name: "Альфа",
      inn: null,
      gln: "4603333000035",
      gs1Prefixes: [],
      archived: false,
      expectedRev: 7,
    });
    expect(names()).toEqual(["Альфа", "Завод 2", "Завод 10", "ООО «Северный берег»"]);
  });

  it("offers to load the list again after a stale change", async () => {
    const session = adminSession();
    session.api.updateCounterparty.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 13 },
      }),
    );
    await openCounterparties(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить контрагента «ООО «Северный берег»»" }),
    );
    type("Название", "ООО «Северный берег-2»");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listCounterparties).toHaveBeenCalledTimes(2));
  });

  it("puts the host's refusal of a field under that field", async () => {
    const session = adminSession();
    session.api.createCounterparty.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "the GLN must be 13 digits",
        details: { field: "gln" },
      }),
    );
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    type("Название", "ООО «Юг»");
    type("GLN контрагента", "4607091000009");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.getByLabelText("GLN контрагента").getAttribute("aria-describedby")).toBe(
      message.id,
    );
  });

  it("sends one request for a double click, and none while it is on its way", async () => {
    const session = adminSession();
    let answer: (record: CounterpartyRecord) => void = () => undefined;
    session.api.createCounterparty.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    type("Название", "ООО «Юг»");
    type("GLN контрагента", "4607091000009");
    const add = within(dialog()).getByRole("button", { name: "Добавить" });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(add).toHaveProperty("disabled", true));
    fireEvent.click(add);
    expect(session.api.createCounterparty).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ ...NORTH, id: "0f1e2d3c-4b5a-4968-8776-655443322110", name: "ООО «Юг»", rev: 20 });
    });
    expect(await screen.findByText("Контрагент «ООО «Юг»» добавлен.")).toBeTruthy();
    expect(session.api.createCounterparty).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/counterparties-page.test.tsx`
Expected: FAIL — все 10 тестов: `Unable to find role="link" and name "Контрагенты"`.

- [ ] **Step 3: Общие части списков, форма, диалог, страница, меню и тексты**

1. Create `apps/standalone/src/office/records.tsx`:

```tsx
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { StatusChip } from "@markiro/ui";

/** Names in Russian order, with numbers by value: «Линия 2» before «Линия 10». */
const NAMES = new Intl.Collator("ru", { numeric: true });

/** A record that is archived instead of deleted. */
export interface ArchivableRecord {
  id: string;
  name: string;
  archived: boolean;
}

/**
 * Active records before archived ones, each group by name (`NAMES`), then by
 * id so equal names keep one order. The host sorts bytewise («Линия 10»
 * before «Линия 2»), so a page sorts what it shows itself.
 */
export function activeFirstByName<T extends ArchivableRecord>(records: readonly T[]): T[] {
  return [...records].sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      NAMES.compare(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** `records` with `record` in place of the one with its id, or added. */
export function withRecord<T extends { id: string }>(records: readonly T[], record: T): T[] {
  return [...records.filter((each) => each.id !== record.id), record];
}

/**
 * Keeps a record a write returned in the cached list of `key`, in place of
 * the one with its id or added; with no list loaded, the whole list is read
 * again rather than shown as one row.
 */
export function useStoreRecord<T extends { id: string }>(key: QueryKey): (record: T) => void {
  const queryClient = useQueryClient();
  return (record) => {
    const list = queryClient.getQueryData<T[]>(key);
    if (list) {
      queryClient.setQueryData(key, withRecord(list, record));
    } else {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** Whether a record is in use or archived, in words and not by colour alone. */
export function ArchiveStatus({ archived }: { archived: boolean }) {
  const { t } = useTranslation();
  return (
    <StatusChip
      phase={archived ? "retired" : "active"}
      label={t(archived ? "office.common.archived" : "office.common.active")}
    />
  );
}
```

2. Create `apps/standalone/src/office/counterparties/counterparty-form.ts`:

```ts
import { z } from "zod";

import type { CounterpartyRecord } from "../../host/protocol.js";
import type { CompanyInput } from "../../host/requests.js";
import {
  companyNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  parsePrefixList,
} from "../../lib/rules.js";

/** A counterparty as the form holds it; `gs1Prefixes` is one comma-separated string. */
export const counterpartyFieldsSchema = z.object({
  name: companyNameRule,
  inn: innRule,
  gln: glnRule,
  gs1Prefixes: gs1PrefixesRule,
  archived: z.boolean(),
});
export type CounterpartyFields = z.input<typeof counterpartyFieldsSchema>;

/** The host names a counterparty's fields as the form does (`validate::company`). */
export const COUNTERPARTY_FIELDS = {
  name: "name",
  inn: "inn",
  gln: "gln",
  gs1Prefixes: "gs1Prefixes",
} as const;

/** The form's values for a counterparty, or empty ones for a new counterparty. */
export function counterpartyFields(counterparty: CounterpartyRecord | null): CounterpartyFields {
  if (counterparty === null) {
    return { name: "", inn: "", gln: "", gs1Prefixes: "", archived: false };
  }
  return {
    name: counterparty.name,
    inn: counterparty.inn ?? "",
    gln: counterparty.gln,
    gs1Prefixes: counterparty.gs1Prefixes.join(", "),
    archived: counterparty.archived,
  };
}

/** The host's company fields for form values: trimmed, an empty INN is none, prefixes a list. */
export function toCompanyInput(values: CounterpartyFields): CompanyInput {
  const inn = values.inn.trim();
  return {
    name: values.name.trim(),
    inn: inn === "" ? null : inn,
    gln: values.gln.trim(),
    gs1Prefixes: parsePrefixList(values.gs1Prefixes),
  };
}
```

3. Create `apps/standalone/src/office/counterparties/CounterpartyDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, Input } from "@markiro/ui";

import type { CounterpartyRecord } from "../../host/protocol.js";
import { counterpartyCreate, counterpartyUpdate } from "../../host/requests.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  COUNTERPARTY_FIELDS,
  counterpartyFields,
  counterpartyFieldsSchema,
  toCompanyInput,
  type CounterpartyFields,
} from "./counterparty-form.js";

export interface CounterpartyDialogProps {
  /** `null` adds a counterparty. */
  counterparty: CounterpartyRecord | null;
  onClose: () => void;
  onSaved: (counterparty: CounterpartyRecord) => void;
  /** The counterparty changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Adds a counterparty, or changes one: the host takes the whole record with
 * the loaded revision, and archiving is its `archived` flag (no delete).
 */
export function CounterpartyDialog({
  counterparty,
  onClose,
  onSaved,
  onReload,
}: CounterpartyDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: CounterpartyFields) => {
    const company = toCompanyInput(values);
    return counterparty === null
      ? api.createCounterparty(token, counterpartyCreate(company))
      : api.updateCounterparty(
          token,
          counterparty.id,
          counterpartyUpdate(company, values.archived, counterparty.rev),
        );
  });
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<CounterpartyFields>({
    resolver: zodResolver(counterpartyFieldsSchema),
    defaultValues: counterpartyFields(counterparty),
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await save.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, COUNTERPARTY_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={
        counterparty === null
          ? t("office.counterparties.createTitle")
          : t("office.counterparties.editTitle", { name: counterparty.name })
      }
      submitLabel={
        counterparty === null ? t("office.counterparties.create") : t("office.common.save")
      }
      submitDisabled={counterparty !== null && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Input
        label={t("office.counterparties.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("org.inn")}
        hint={t("org.innHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.inn?.message)}
        {...register("inn")}
      />
      <Input
        label={t("office.counterparties.fields.gln")}
        hint={t("office.counterparties.fields.glnHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.gln?.message)}
        {...register("gln")}
      />
      <Input
        label={t("org.gs1Prefixes")}
        hint={t("org.gs1PrefixesHint")}
        mono
        {...fieldError(errors.gs1Prefixes?.message)}
        {...register("gs1Prefixes")}
      />
      {counterparty !== null && (
        <Controller
          control={control}
          name="archived"
          render={({ field }) => (
            <Checkbox
              label={t("office.counterparties.fields.archived")}
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
      )}
    </FormDialog>
  );
}
```

4. Create `apps/standalone/src/office/counterparties/CounterpartiesPage.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PageHeader, Table, type TableColumn } from "@markiro/ui";

import type { CounterpartyRecord } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, ArchiveStatus, useStoreRecord } from "../records.js";
import { CounterpartyDialog } from "./CounterpartyDialog.js";

type CounterpartiesDialog = { kind: "create" } | { kind: "edit"; counterparty: CounterpartyRecord };

/**
 * Counterparties (spec §4.3, §4.8): customers of contract manufacturing.
 * Administrators add, change and archive them; technologists read the list.
 */
export function CounterpartiesPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const store = useStoreRecord<CounterpartyRecord>(officeKeys.counterparties);
  const [dialog, setDialog] = useState<CounterpartiesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: CounterpartiesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const none = t("office.common.none");

  const columns: TableColumn<CounterpartyRecord>[] = [
    {
      key: "name",
      title: t("office.counterparties.table.name"),
      render: (counterparty) => counterparty.name,
    },
    {
      key: "inn",
      title: t("office.counterparties.table.inn"),
      mono: true,
      render: (counterparty) => counterparty.inn ?? none,
    },
    {
      key: "gln",
      title: t("office.counterparties.table.gln"),
      mono: true,
      render: (counterparty) => counterparty.gln,
    },
    {
      key: "gs1Prefixes",
      title: t("office.counterparties.table.gs1Prefixes"),
      mono: true,
      render: (counterparty) =>
        counterparty.gs1Prefixes.length > 0 ? counterparty.gs1Prefixes.join(", ") : none,
    },
    {
      key: "status",
      title: t("office.counterparties.table.status"),
      render: (counterparty) => <ArchiveStatus archived={counterparty.archived} />,
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.counterparties.table.actions"),
      render: (counterparty) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.counterparties.editNamed", { name: counterparty.name })}
          onClick={() => open({ kind: "edit", counterparty })}
        >
          {t("office.counterparties.edit")}
        </Button>
      ),
    });
  }

  const content = () => {
    if (counterparties.isPending) return <PageLoading />;
    if (counterparties.isError) {
      return (
        <LoadError error={counterparties.error} onRetry={() => void counterparties.refetch()} />
      );
    }
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByName(counterparties.data)}
          getRowKey={(counterparty) => counterparty.id}
          empty={t("office.counterparties.empty")}
          scrollLabel={t("office.counterparties.title")}
        />
        {!canEdit && <p className="office-note">{t("office.common.readOnly")}</p>}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.counterparties.title")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>
              {t("office.counterparties.add")}
            </Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {canEdit && dialog !== null && (
        <CounterpartyDialog
          counterparty={dialog.kind === "edit" ? dialog.counterparty : null}
          onClose={() => setDialog(null)}
          onSaved={(counterparty) => {
            store(counterparty);
            setDialog(null);
            setNotice(
              dialog.kind === "create"
                ? t("office.counterparties.created", { name: counterparty.name })
                : t("office.common.saved"),
            );
          }}
          onReload={() => {
            setDialog(null);
            void counterparties.refetch();
          }}
        />
      )}
    </>
  );
}
```

5. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  sscc: ["office", "sscc"],
  users: ["office", "users"],
  devices: ["office", "devices"],
  /** Line names from this installation's local copies, not from the host. */
  lineNames: ["office", "line-names"],
} as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  sscc: ["office", "sscc"],
  users: ["office", "users"],
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  /** Line names from this installation's local copies, not from the host. */
  lineNames: ["office", "line-names"],
} as const;
```

6. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
```

заменить на

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/counterparties",
    labelKey: "office.nav.counterparties",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
```

7. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import type { RouteObject } from "react-router";

import { DevicesPage } from "./devices/DevicesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { RouteObject } from "react-router";

import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
```

8. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { index: true, element: <OfficeOverview /> },
      { path: "org", element: <OrgProfilePage /> },
      { path: "sscc", element: <SsccPage /> },
      {
        path: "devices",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
      { index: true, element: <OfficeOverview /> },
      { path: "org", element: <OrgProfilePage /> },
      { path: "sscc", element: <SsccPage /> },
      { path: "counterparties", element: <CounterpartiesPage /> },
      {
        path: "devices",
        element: (
```

9. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "overview": "Обзор",
      "orgProfile": "Профиль",
      "sscc": "SSCC",
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

заменить на

<!-- prettier-ignore -->
```json
      "overview": "Обзор",
      "orgProfile": "Профиль",
      "sscc": "SSCC",
      "counterparties": "Контрагенты",
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

10. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "close": "Закрыть",
      "saved": "Изменения сохранены.",
      "none": "—",
      "readOnly": "Изменять эти данные может только администратор."
    },
    "org": {
      "title": "Профиль организации",
```

заменить на

<!-- prettier-ignore -->
```json
      "close": "Закрыть",
      "saved": "Изменения сохранены.",
      "none": "—",
      "readOnly": "Изменять эти данные может только администратор.",
      "active": "Действует",
      "archived": "В архиве"
    },
    "org": {
      "title": "Профиль организации",
```

11. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "boxBlock": "Укажите целое число от 1 до 100 000",
        "palletBlock": "Укажите целое число от 1 до 10 000"
      }
    },
    "users": {
      "title": "Пользователи офиса",
```

заменить на

<!-- prettier-ignore -->
```json
        "boxBlock": "Укажите целое число от 1 до 100 000",
        "palletBlock": "Укажите целое число от 1 до 10 000"
      }
    },
    "counterparties": {
      "title": "Контрагенты",
      "add": "Добавить контрагента",
      "empty": "Контрагентов пока нет.",
      "table": {
        "name": "Название",
        "inn": "ИНН",
        "gln": "GLN",
        "gs1Prefixes": "Префиксы GS1",
        "status": "Состояние",
        "actions": "Действия"
      },
      "edit": "Изменить",
      "editNamed": "Изменить контрагента «{{name}}»",
      "createTitle": "Новый контрагент",
      "create": "Добавить",
      "editTitle": "Контрагент «{{name}}»",
      "fields": {
        "name": "Название",
        "gln": "GLN контрагента",
        "glnHint": "13 цифр",
        "archived": "В архиве"
      },
      "created": "Контрагент «{{name}}» добавлен."
    },
    "users": {
      "title": "Пользователи офиса",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем она же с `--reporter=verbose`.
Expected: PASS — 10 тестов; stderr пуст.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Office pages», фрагмент

<!-- prettier-ignore -->
```text
- Request bodies are built field by field, never spread from form values, so
  nothing the form holds reaches the host by accident; ids go into the path
  only.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

заменить на

<!-- prettier-ignore -->
```text
- Request bodies are built field by field, never spread from form values, so
  nothing the form holds reaches the host by accident; ids go into the path
  only.
- Lists of archivable records (counterparties, lines) show active records
  before archived ones, each by name in Russian order with numbers by value
  (`activeFirstByName` in `src/office/records.tsx`, with
  `Intl.Collator("ru", { numeric: true })`); the host sorts bytewise, which
  puts «Линия 10» before «Линия 2».
- «Контрагенты» is read by every role and changed by administrators. An edit
  sends the whole record with `expectedRev`; archiving is the dialog's «В
  архиве» box, and there is no delete. The host keeps no uniqueness for
  counterparties (an owner question), so the page checks no duplicates; a
  second click while the request is on its way sends nothing.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.5, фрагмент

<!-- prettier-ignore -->
```text
  понятия (тенант, `useCan`, подписка, Нацкаталог, фото через сервер) убираются.
  Формы проверяют поля правилами `@markiro/domain` (`normalizeToGtin14`,
  `gtinMatchesPrefix`, `labelTemplateSpecSchema`) до отправки на хост.
- Операторы: интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль
  площадки из `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет
  только хеши.
```

заменить на

<!-- prettier-ignore -->
```text
  понятия (тенант, `useCan`, подписка, Нацкаталог, фото через сервер) убираются.
  Формы проверяют поля правилами `@markiro/domain` (`normalizeToGtin14`,
  `gtinMatchesPrefix`, `labelTemplateSpecSchema`) до отправки на хост.
- Контрагенты (план 1d3): список видят все роли, меняет администратор. Правка
  отправляет запись целиком с `expectedRev`; архив — флажок «В архиве» в той же
  форме, удаления нет. Уникальности контрагентов на хосте нет (вопрос владельцу
  открыт), поэтому форма дубликаты не ищет, а второй щелчок, пока запрос идёт,
  ничего не отправляет. Списки контрагентов и линий показывают действующие
  записи перед архивными, внутри — по названию с числами по значению
  (`Intl.Collator("ru", { numeric: true })`): «Линия 2» раньше «Линия 10».
- Операторы: интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль
  площадки из `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет
  только хеши.
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 31 файл, 594 теста.

```bash
git add apps/standalone/src/office/records.tsx apps/standalone/src/office/counterparties/counterparty-form.ts apps/standalone/src/office/counterparties/CounterpartyDialog.tsx apps/standalone/src/office/counterparties/CounterpartiesPage.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/counterparties-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): страница «Контрагенты» в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Страница «Линии» — `src/office/lines/`

`GET /v1/office/lines` отдаёт и архивные линии; `POST { name }` добавляет, `PUT { name?, archived?, expectedRev }` меняет только присланное. Название, занятое активной линией без учёта регистра, — `conflict` с `constraint: line_name` при добавлении, переименовании и возврате из архива; страница показывает его под названием. Архивирование не трогает устройства: станция может остаться на архивной линии, и подтверждение так и говорит.

Действия администратора: «Добавить линию», у действующей — «Переименовать» и «В архив», у архивной — «Вернуть». Возврат — диалог с названием: если название уже заняла другая линия, ошибка ложится под поле, и линии тут же можно дать другое. Технолог видит список только для чтения.

С «Линиями» в разделе «Производство» технолог видит этот раздел, поэтому тест «Устройств» про меню меняет последнее утверждение: вместо «раздела нет» он проверяет, что в нём есть «Линии».

**Files:**

- Create: `apps/standalone/src/office/lines/{LineDialog.tsx,ArchiveLineDialog.tsx,LinesPage.tsx}`, `apps/standalone/test/lines-page.test.tsx`
- Modify: `apps/standalone/src/office/{office-query.ts,nav.ts,routes.tsx}`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/devices-page.test.tsx`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes:
  - `FormDialog`, `writeFailure`, `alertFailure`, `useFieldError`, `WriteFailureAlert`, `useCan("editReference")` — задача 1; `lineNameRule` — задача 2;
  - `OfficeLine`, `lineCreate`, `lineUpdate`, `HostApi.listLines/createLine/updateLine` — задача 3;
  - `activeFirstByName`, `ArchiveStatus`, `useStoreRecord` — задача 4.
- Produces:
  - `officeKeys.lines = ["office", "lines"]` (задача 6 берёт его для «Устройств»);
  - `type LineDialogMode = { kind: "create" } | { kind: "rename"; line } | { kind: "restore"; line }`, `LineDialog({ mode, onClose, onSaved, onReload })`, `ArchiveLineDialog({ line, onClose, onArchived, onReload })`, `LinesPage()`; маршрут `/lines`, пункт меню «Линии».

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/lines-page.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeLine } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const LINE_2: OfficeLine = {
  id: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  name: "Линия 2",
  archived: false,
  rev: 40,
};
const LINE_10: OfficeLine = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  name: "Линия 10",
  archived: false,
  rev: 41,
};
const PACKING: OfficeLine = {
  id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Фасовка",
  archived: false,
  rev: 42,
};
const OLD_LINE: OfficeLine = {
  id: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
  name: "Линия 1",
  archived: true,
  rev: 30,
};

function conflict(): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "another active line has this name",
    details: { constraint: "line_name" },
  });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  // The host's own order (archived last, names bytewise): the page sorts again.
  session.api.listLines.mockResolvedValue([LINE_10, LINE_2, PACKING, OLD_LINE]);
  return session;
}

async function openLines(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Линии" }));
  await screen.findByText("Фасовка");
}

/** The names column, top to bottom. */
function names(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("office lines", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for both roles, under «Производство»", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    expect(await screen.findByRole("link", { name: "Линии" })).toBeTruthy();
    expect(screen.getByText("Производство")).toBeTruthy();
  });

  it("lists the lines by name, numbers in order, archived ones last", async () => {
    await openLines(adminSession());
    expect(names()).toEqual(["Линия 2", "Линия 10", "Фасовка", "Линия 1"]);
    expect(within(rowOf("Линия 10")).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Линия 1")).getByText("В архиве")).toBeTruthy();
    expect(
      within(rowOf("Линия 1")).getByRole("button", { name: "Вернуть линию «Линия 1» из архива" }),
    ).toBeTruthy();
    expect(within(rowOf("Линия 1")).queryByRole("button", { name: /Переименовать/ })).toBeNull();
  });

  it("shows a technologist the lines without a way to change them", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.listLines.mockResolvedValue([LINE_2, OLD_LINE]);
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Линии" }));
    await screen.findByText("Линия 2");
    expect(screen.queryByRole("button", { name: "Добавить линию" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Переименовать|архив/ })).toBeNull();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("adds a line with its trimmed name", async () => {
    const session = adminSession();
    session.api.createLine.mockResolvedValue({
      id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      name: "Линия 3",
      archived: false,
      rev: 50,
    });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "  Линия 3 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Линия «Линия 3» добавлена.")).toBeTruthy();
    expect(session.api.createLine.mock.calls).toStrictEqual([
      ["office-session-token", { name: "Линия 3" }],
    ]);
    expect(names()).toEqual(["Линия 2", "Линия 3", "Линия 10", "Фасовка", "Линия 1"]);
  });

  it("says under the name when an active line already has it", async () => {
    const session = adminSession();
    session.api.createLine.mockRejectedValueOnce(conflict());
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "фасовка");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Активная линия с таким названием уже есть");
    expect(screen.getByLabelText("Название линии").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("refuses a control character in the name before sending", async () => {
    const session = adminSession();
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "Линия\t3");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Укажите название линии, до 100 символов")).toBeTruthy();
    expect(session.api.createLine).not.toHaveBeenCalled();
  });

  it("renames a line with the loaded revision, sending only the name", async () => {
    const session = adminSession();
    session.api.updateLine
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ ...LINE_2, name: "Линия 2а", rev: 51 });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Переименовать линию «Линия 2»" }));
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Название линии", "Линия 10");
    fireEvent.click(save);
    expect(await screen.findByText("Активная линия с таким названием уже есть")).toBeTruthy();
    type("Название линии", "Линия 2а");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateLine.mock.calls).toStrictEqual([
      ["office-session-token", LINE_2.id, { name: "Линия 10", expectedRev: 40 }],
      ["office-session-token", LINE_2.id, { name: "Линия 2а", expectedRev: 40 }],
    ]);
    expect(rowOf("Линия 2а")).toBeTruthy();
  });

  it("offers to load the lines again after a stale change", async () => {
    const session = adminSession();
    session.api.updateLine.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 45 },
      }),
    );
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Переименовать линию «Линия 2»" }));
    type("Название линии", "Линия 2а");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listLines).toHaveBeenCalledTimes(2));
  });

  it("archives a line after saying that its stations stay on it", async () => {
    const session = adminSession();
    session.api.updateLine.mockResolvedValue({ ...PACKING, archived: true, rev: 52 });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Убрать линию «Фасовка» в архив" }));
    expect(
      within(dialog()).getByText(
        "Линию «Фасовка» больше нельзя будет выбрать на станции. Станции, которые уже работают на ней, останутся на этой линии, пока их не переведут в разделе «Устройства».",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "В архив" }));
    expect(await screen.findByText("Линия «Фасовка» убрана в архив.")).toBeTruthy();
    expect(session.api.updateLine.mock.calls).toStrictEqual([
      ["office-session-token", PACKING.id, { archived: true, expectedRev: 42 }],
    ]);
    expect(names()).toEqual(["Линия 2", "Линия 10", "Линия 1", "Фасовка"]);
    expect(within(rowOf("Фасовка")).getByText("В архиве")).toBeTruthy();
  });

  it("brings a line back from the archive, renaming it when an active line took its name", async () => {
    const session = adminSession();
    session.api.updateLine
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ ...OLD_LINE, name: "Линия 1 (старая)", archived: false, rev: 53 });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Вернуть линию «Линия 1» из архива" }));
    expect(
      within(dialog()).getByText(
        "Линия снова появится в выборе линии на станциях. Если её название уже заняла другая линия, дайте ей новое.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Вернуть" }));
    expect(await screen.findByText("Активная линия с таким названием уже есть")).toBeTruthy();
    type("Название линии", "Линия 1 (старая)");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Вернуть" }));
    expect(await screen.findByText("Линия «Линия 1 (старая)» возвращена из архива.")).toBeTruthy();
    expect(session.api.updateLine.mock.calls).toStrictEqual([
      ["office-session-token", OLD_LINE.id, { archived: false, expectedRev: 30 }],
      [
        "office-session-token",
        OLD_LINE.id,
        { name: "Линия 1 (старая)", archived: false, expectedRev: 30 },
      ],
    ]);
    expect(names()).toEqual(["Линия 1 (старая)", "Линия 2", "Линия 10", "Фасовка"]);
  });
});
```

2. В `apps/standalone/test/devices-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Устройства" })).toBeNull();
    expect(screen.queryByText("Производство")).toBeNull();
  });

  it("lists the devices, naming lines from the local copies", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Устройства" })).toBeNull();
    // «Производство» stays for the technologist: it holds «Линии».
    expect(screen.getByRole("link", { name: "Линии" })).toBeTruthy();
  });

  it("lists the devices, naming lines from the local copies", async () => {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lines-page.test.tsx test/devices-page.test.tsx`
Expected: FAIL — 11 тестов из 27:

- `lines-page.test.tsx`, все 10: `Unable to find role="link" and name "Линии"`;
- `devices-page.test.tsx`, 1 из 17: «is in the menu for administrators only» — `Unable to find an accessible element with the role "link" and name "Линии"`.

- [ ] **Step 3: Диалоги, страница, меню и тексты**

1. Create `apps/standalone/src/office/lines/LineDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import type { OfficeLine } from "../../host/protocol.js";
import { lineCreate, lineUpdate } from "../../host/requests.js";
import { lineNameRule } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

const lineFieldsSchema = z.object({ name: lineNameRule });
type LineFields = z.input<typeof lineFieldsSchema>;

const LINE_FIELDS = { name: "name" } as const;
/** An active line already has the name, compared without case (`lines_active_name_key`). */
const LINE_CONFLICTS = {
  line_name: { field: "name", message: "office.lines.errors.nameTaken" },
} as const;

/** What the dialog does: add a line, rename an active one, or bring one back from the archive. */
export type LineDialogMode =
  { kind: "create" } | { kind: "rename"; line: OfficeLine } | { kind: "restore"; line: OfficeLine };

export interface LineDialogProps {
  mode: LineDialogMode;
  onClose: () => void;
  onSaved: (line: OfficeLine) => void;
  /** The line changed on the host: close and load the lines again. */
  onReload: () => void;
}

/**
 * A line's name. A name an active line already has (without case) comes back
 * as `conflict` on `line_name` on every path here — adding, renaming and
 * bringing a line back — and goes under the name, so bringing a line back can
 * give it a new name in the same dialog.
 */
export function LineDialog({ mode, onClose, onSaved, onReload }: LineDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, name: string) => {
    switch (mode.kind) {
      case "create":
        return api.createLine(token, lineCreate(name));
      case "rename":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, { name, archived: mode.line.archived }),
        );
      case "restore":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, { name, archived: false }),
        );
    }
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<LineFields>({
    resolver: zodResolver(lineFieldsSchema),
    defaultValues: { name: mode.kind === "create" ? "" : mode.line.name },
  });

  const submit = handleSubmit(async ({ name }) => {
    setFailure(null);
    try {
      onSaved(await save.mutateAsync(name));
    } catch (error) {
      const outcome = writeFailure(error, LINE_FIELDS, LINE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  const title =
    mode.kind === "create"
      ? t("office.lines.createTitle")
      : mode.kind === "rename"
        ? t("office.lines.renameTitle", { name: mode.line.name })
        : t("office.lines.restoreTitle");
  const submitLabel =
    mode.kind === "create"
      ? t("office.lines.create")
      : mode.kind === "rename"
        ? t("office.common.save")
        : t("office.lines.restoreSubmit");

  return (
    <FormDialog
      title={title}
      submitLabel={submitLabel}
      submitDisabled={mode.kind === "rename" && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      {mode.kind === "restore" && <p>{t("office.lines.restoreIntro")}</p>}
      <Input
        label={t("office.lines.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
    </FormDialog>
  );
}
```

2. Create `apps/standalone/src/office/lines/ArchiveLineDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfficeLine } from "../../host/protocol.js";
import { lineUpdate } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface ArchiveLineDialogProps {
  line: OfficeLine;
  onClose: () => void;
  onArchived: (line: OfficeLine) => void;
  /** The line changed on the host: close and load the lines again. */
  onReload: () => void;
}

/**
 * Asks before a line goes to the archive. Archiving leaves the devices on the
 * line alone: a station already on it stays there until an administrator
 * moves it in «Устройства»; no station can choose it any more.
 */
export function ArchiveLineDialog({ line, onClose, onArchived, onReload }: ArchiveLineDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const archive = useOfficeMutation((api, token, _variables: void) =>
    api.updateLine(token, line.id, lineUpdate(line, { name: line.name, archived: true })),
  );

  const submit = async () => {
    setFailure(null);
    try {
      onArchived(await archive.mutateAsync());
    } catch (error) {
      setFailure(alertFailure(error));
    }
  };

  return (
    <FormDialog
      title={t("office.lines.archiveTitle")}
      submitLabel={t("office.lines.archiveSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.lines.archiveBody", { name: line.name })}</p>
    </FormDialog>
  );
}
```

3. Create `apps/standalone/src/office/lines/LinesPage.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PageHeader, RowActions, Table, type TableColumn } from "@markiro/ui";

import type { OfficeLine } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, ArchiveStatus, useStoreRecord } from "../records.js";
import { ArchiveLineDialog } from "./ArchiveLineDialog.js";
import { LineDialog, type LineDialogMode } from "./LineDialog.js";

type LinesDialog = LineDialogMode | { kind: "archive"; line: OfficeLine };

/**
 * Production lines (spec §4.3, §4.8), archived ones included. Administrators
 * add, rename, archive and bring back lines; technologists read the list.
 */
export function LinesPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const store = useStoreRecord<OfficeLine>(officeKeys.lines);
  const [dialog, setDialog] = useState<LinesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: LinesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (line: OfficeLine, message: string) => {
    store(line);
    setDialog(null);
    setNotice(message);
  };
  const savedNotice = (kind: LineDialogMode["kind"], line: OfficeLine) => {
    switch (kind) {
      case "create":
        return t("office.lines.created", { name: line.name });
      case "rename":
        return t("office.common.saved");
      case "restore":
        return t("office.lines.restored", { name: line.name });
    }
  };
  const reload = () => {
    setDialog(null);
    void lines.refetch();
  };

  const columns: TableColumn<OfficeLine>[] = [
    { key: "name", title: t("office.lines.table.name"), render: (line) => line.name },
    {
      key: "status",
      title: t("office.lines.table.status"),
      render: (line) => <ArchiveStatus archived={line.archived} />,
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.lines.table.actions"),
      render: (line) =>
        line.archived ? (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.lines.restoreNamed", { name: line.name })}
            onClick={() => open({ kind: "restore", line })}
          >
            {t("office.lines.restore")}
          </Button>
        ) : (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.lines.renameNamed", { name: line.name })}
              onClick={() => open({ kind: "rename", line })}
            >
              {t("office.lines.rename")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.lines.archiveNamed", { name: line.name })}
              onClick={() => open({ kind: "archive", line })}
            >
              {t("office.lines.archive")}
            </Button>
          </RowActions>
        ),
    });
  }

  const content = () => {
    if (lines.isPending) return <PageLoading />;
    if (lines.isError)
      return <LoadError error={lines.error} onRetry={() => void lines.refetch()} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByName(lines.data)}
          getRowKey={(line) => line.id}
          empty={t("office.lines.empty")}
          scrollLabel={t("office.lines.title")}
        />
        {!canEdit && <p className="office-note">{t("office.common.readOnly")}</p>}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.lines.title")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.lines.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {canEdit && dialog !== null && dialog.kind === "archive" && (
        <ArchiveLineDialog
          line={dialog.line}
          onClose={() => setDialog(null)}
          onArchived={(line) => saved(line, t("office.lines.archived", { name: line.name }))}
          onReload={reload}
        />
      )}
      {canEdit && dialog !== null && dialog.kind !== "archive" && (
        <LineDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(line) => saved(line, savedNotice(dialog.kind, line))}
          onReload={reload}
        />
      )}
    </>
  );
}
```

4. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  users: ["office", "users"],
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  /** Line names from this installation's local copies, not from the host. */
  lineNames: ["office", "line-names"],
} as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  users: ["office", "users"],
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
  /** Line names from this installation's local copies, not from the host. */
  lineNames: ["office", "line-names"],
} as const;
```

5. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
```

заменить на

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/lines",
    labelKey: "office.nav.lines",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
```

6. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx

import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { LinesPage } from "./lines/LinesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
```

7. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "org", element: <OrgProfilePage /> },
      { path: "sscc", element: <SsccPage /> },
      { path: "counterparties", element: <CounterpartiesPage /> },
      {
        path: "devices",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "org", element: <OrgProfilePage /> },
      { path: "sscc", element: <SsccPage /> },
      { path: "counterparties", element: <CounterpartiesPage /> },
      { path: "lines", element: <LinesPage /> },
      {
        path: "devices",
        element: (
```

8. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "orgProfile": "Профиль",
      "sscc": "SSCC",
      "counterparties": "Контрагенты",
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

заменить на

<!-- prettier-ignore -->
```json
      "orgProfile": "Профиль",
      "sscc": "SSCC",
      "counterparties": "Контрагенты",
      "lines": "Линии",
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

9. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "archived": "В архиве"
      },
      "created": "Контрагент «{{name}}» добавлен."
    },
    "users": {
      "title": "Пользователи офиса",
```

заменить на

<!-- prettier-ignore -->
```json
        "archived": "В архиве"
      },
      "created": "Контрагент «{{name}}» добавлен."
    },
    "lines": {
      "title": "Линии",
      "add": "Добавить линию",
      "empty": "Линий пока нет.",
      "table": {
        "name": "Название",
        "status": "Состояние",
        "actions": "Действия"
      },
      "rename": "Переименовать",
      "renameNamed": "Переименовать линию «{{name}}»",
      "archive": "В архив",
      "archiveNamed": "Убрать линию «{{name}}» в архив",
      "restore": "Вернуть",
      "restoreNamed": "Вернуть линию «{{name}}» из архива",
      "createTitle": "Новая линия",
      "create": "Добавить",
      "renameTitle": "Линия «{{name}}»",
      "restoreTitle": "Вернуть линию из архива",
      "restoreIntro": "Линия снова появится в выборе линии на станциях. Если её название уже заняла другая линия, дайте ей новое.",
      "restoreSubmit": "Вернуть",
      "archiveTitle": "Убрать линию в архив?",
      "archiveBody": "Линию «{{name}}» больше нельзя будет выбрать на станции. Станции, которые уже работают на ней, останутся на этой линии, пока их не переведут в разделе «Устройства».",
      "archiveSubmit": "В архив",
      "fields": {
        "name": "Название линии"
      },
      "created": "Линия «{{name}}» добавлена.",
      "archived": "Линия «{{name}}» убрана в архив.",
      "restored": "Линия «{{name}}» возвращена из архива.",
      "errors": {
        "nameTaken": "Активная линия с таким названием уже есть"
      }
    },
    "users": {
      "title": "Пользователи офиса",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем `… exec vitest run test/lines-page.test.tsx --reporter=verbose`.
Expected: PASS — 10 тестов в `lines-page.test.tsx`, 17 в `devices-page.test.tsx` (27); stderr пуст.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Office pages», фрагмент

<!-- prettier-ignore -->
```text
  архиве» box, and there is no delete. The host keeps no uniqueness for
  counterparties (an owner question), so the page checks no duplicates; a
  second click while the request is on its way sends nothing.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

заменить на

<!-- prettier-ignore -->
```text
  архиве» box, and there is no delete. The host keeps no uniqueness for
  counterparties (an owner question), so the page checks no duplicates; a
  second click while the request is on its way sends nothing.
- «Линии» lists every line, archived ones included; every role reads it and
  administrators change it. A name an active line already has, compared
  without case, answers `conflict` on `line_name` when adding, renaming or
  bringing a line back from the archive, and goes under the name: bringing a
  line back is a dialog with its name, so it can take another one. Archiving
  asks first and says that stations already on the line stay there: the host
  does not touch devices when a line is archived.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.5, фрагмент

<!-- prettier-ignore -->
```text
  ничего не отправляет. Списки контрагентов и линий показывают действующие
  записи перед архивными, внутри — по названию с числами по значению
  (`Intl.Collator("ru", { numeric: true })`): «Линия 2» раньше «Линия 10».
- Операторы: интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль
  площадки из `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет
  только хеши.
```

заменить на

<!-- prettier-ignore -->
```text
  ничего не отправляет. Списки контрагентов и линий показывают действующие
  записи перед архивными, внутри — по названию с числами по значению
  (`Intl.Collator("ru", { numeric: true })`): «Линия 2» раньше «Линия 10».
- Линии (план 1d3): список со всеми линиями, архивные тоже; видят все роли,
  меняет администратор — добавляет, переименовывает, убирает в архив и
  возвращает. Название, занятое активной линией без учёта регистра, — ошибка
  под полем названия при добавлении, переименовании и возврате из архива
  (`conflict` с `constraint: line_name`); возврат — диалог с названием, чтобы
  линии можно было дать другое. Архивирование спрашивает подтверждение и
  говорит, что станции на линии остаются на ней: хост устройства не трогает.
- Операторы: интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль
  площадки из `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет
  только хеши.
```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 32 файла, 604 теста.

```bash
git add apps/standalone/src/office/lines/LineDialog.tsx apps/standalone/src/office/lines/ArchiveLineDialog.tsx apps/standalone/src/office/lines/LinesPage.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/lines-page.test.tsx apps/standalone/test/devices-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): страница «Линии» в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: «Устройства» — правка, отзыв, «Новый код» с `replaces` и срок кода от хоста

Страница «Устройства» плана 1c3 только показывает устройства и выдаёт коды. Задача добавляет:

- **Правку.** Имя и линия меняются одним диалогом, на хост уходят только изменённые поля (`deviceUpdate`). Линия есть только у станции: у другого вида устройства поля линии нет. Выбрать можно только активную линию. Текущая линия станции остаётся в списке и после архивирования («Линия 5 (в архиве)»), а оставить её — значит ничего не слать о линии.
- **Названия линий из списка хоста.** И таблица, и диалог берут их из `GET /v1/office/lines`, а не из локальных копий. Линия, добавленная минуту назад, выбирается сразу, таблица и диалог называют линии одинаково. Чтение локальных копий в офисе после этого никому не нужно: `office-local.tsx`, свойство `local` у `Office` и `officeKeys.lineNames` удаляются.
- **Отзыв.** Подтверждение называет устройство и говорит, что отменить отзыв нельзя. После отзыва список читается заново. Отозванное устройство — мёртвая запись: у его строки нет кнопок, хотя хост и позволил бы его править.
- **Код подключения.**
  - «Новый код» шлёт `{ replaces: <id кода на экране> }`, и хост сразу гасит прежний код; без кода на экране — без тела.
  - Второй щелчок, пока запрос идёт, ничего не отправляет. Флаг ставится сразу (`requesting`), а не ждёт `isPending`: тот доходит до кнопки на такт позже, и двойной щелчок оставлял на хосте два живых кода.
  - Срок кода берётся у хоста как длительность `expiresAt − createdAt` и отсчитывается по часам этого ПК от момента запроса; `CODE_LIFETIME_MS` удаляется. Обнаружение подключения берёт `createdAt` прямо: оно сравнивает только метки хоста.
  - Поколение запросов, опрос раз в 3 с и DataMatrix — без изменений.

«Последний раз» остаётся «Последний раз», не «на связи».

**Files:**

- Create: `apps/standalone/src/office/devices/{line-label.ts,DeviceDialog.tsx,RevokeDeviceDialog.tsx}`
- Modify (целиком): `apps/standalone/src/office/devices/DevicesPage.tsx`, `apps/standalone/test/devices-page.test.tsx`
- Modify: `apps/standalone/src/office/devices/PairingCodeDialog.tsx`, `apps/standalone/src/office/{office-query.ts,Office.tsx}`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)
- Delete: `apps/standalone/src/office/office-local.tsx`

**Interfaces:**

- Consumes:
  - `FormDialog`, `writeFailure`, `alertFailure`, `useFieldError`, `WriteFailureAlert` — задача 1; `deviceNameRule` — задача 2;
  - `DeviceRecord`, `OfficeLine`, `PairingCode`, `deviceUpdate`, `pairingCodeRequest`, `HostApi.listLines/updateDevice/revokeDevice/createPairingCode(token, request?)` — задача 3;
  - `activeFirstByName`, `useStoreRecord` — задача 4; `officeKeys.lines` — задача 5.
- Produces:
  - `lineLabel(lines, lineId, t): string` — «—», название, «название (в архиве)» или начало id;
  - `DeviceDialog({ device, lines, onClose, onSaved })`, `RevokeDeviceDialog({ device, onClose, onRevoked })`;
  - `codeLifetimeMs(code: Pick<PairingCode, "createdAt" | "expiresAt">): number` — `src/office/devices/PairingCodeDialog.tsx`; `CODE_LIFETIME_MS` больше нет;
  - `OfficeProps` без `local`.

- [ ] **Step 1: Тесты (падающие)**

Тест страницы переписан целиком. Что в нём нового:

- `adminSession` отдаёт и линии хоста (`listLines`); устройств четыре: станция на активной линии, станция на архивной, офисное устройство и отозванный ТСД;
- названия линий — из списка хоста, архивная помечена, у отозванного устройства нет кнопок;
- правка: только изменённые поля, `lineId: null`, список линий (естественный порядок, текущая архивная — последней), нет линии у офисного устройства, проверка имени, отказ хоста по линии под полем;
- отзыв: текст подтверждения, повторное чтение списка, отказ хоста в диалоге;
- код: запрос без тела со страницы и с `replaces` из диалога, срок жизни от хоста (пять минут), один запрос на двойной щелчок; прежние тесты кода сохранены, `CODE_LIFETIME_MS` заменён своей константой теста.

1. Заменить содержимое `apps/standalone/test/devices-page.test.tsx` целиком:

```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderLiteralDataMatrixSvg } from "@markiro/domain";
import type * as MarkiroDomain from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { DeviceRecord, OfficeLine, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

// The dialog's countdown re-renders every second (fix round 1, item 3):
// `PairingDataMatrix` must not re-encode the DataMatrix on every tick.
// Wrapping the real implementation in a spy keeps the rendered SVG genuine
// (other tests below check for a real `<svg>`) while one test counts calls.
vi.mock("@markiro/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkiroDomain>();
  return { ...actual, renderLiteralDataMatrixSvg: vi.fn(actual.renderLiteralDataMatrixSvg) };
});

/** How long the codes `pairingCode` builds live, by the host's clock. */
const LIFETIME_MS = 10 * 60 * 1000;
const FINGERPRINT = "ab".repeat(32);
const ARCHIVED_LINE_ID = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const LINES: OfficeLine[] = [
  { id: LINE_ID, name: "Линия 1", archived: false, rev: 3 },
  { id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Линия 10", archived: false, rev: 5 },
  { id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", name: "Линия 2", archived: false, rev: 4 },
  { id: ARCHIVED_LINE_ID, name: "Линия 5", archived: true, rev: 6 },
];
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
const PACKING: DeviceRecord = {
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  kind: "station",
  name: "Станция упаковки",
  lineId: ARCHIVED_LINE_ID,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:30:00Z",
  lastSeenAt: null,
  revokedAt: null,
};
const OFFICE_PC: DeviceRecord = {
  id: "8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b",
  kind: "office",
  name: "Офис бухгалтерии",
  lineId: null,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:45:00Z",
  lastSeenAt: null,
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
    id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
    code: "7K3MQ9XV2D",
    createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    expiresAt: new Date(Date.now() + (600 - secondsAgo) * 1000).toISOString(),
    payload: `markiro-host:1?h=${hosts}&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
  };
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED]);
  session.api.listLines.mockResolvedValue(LINES);
  return session;
}

async function openDevices(session: FakeOfficeSession) {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
  await screen.findByText("Рабочее место хоста");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/** The labels of a select's options, top to bottom. */
function optionLabels(select: HTMLElement): (string | null)[] {
  return Array.from(select.querySelectorAll("option"), (option) => option.textContent);
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
    // «Производство» stays for the technologist: it holds «Линии».
    expect(screen.getByRole("link", { name: "Линии" })).toBeTruthy();
  });

  it("lists the devices, naming lines from the host's list", async () => {
    await openDevices(adminSession());
    expect(screen.getByText("Производство")).toBeTruthy();
    const station = rowOf("Рабочее место хоста");
    expect(within(station).getByText("Станция")).toBeTruthy();
    expect(within(station).getByText("Линия 1")).toBeTruthy();
    expect(within(station).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Станция упаковки")).getByText("Линия 5 (в архиве)")).toBeTruthy();
    const retired = rowOf("Старый ТСД");
    expect(within(retired).getByText("ТСД")).toBeTruthy();
    // A line the host's list does not know shows its short id.
    expect(within(retired).getByText("9b2e4a6c…")).toBeTruthy();
    expect(within(retired).getByText("—")).toBeTruthy();
    expect(within(retired).getByText("Отозвано")).toBeTruthy();
    // A revoked device is a dead record: nothing to change on it.
    expect(within(retired).queryByRole("button")).toBeNull();
  });

  it("renames a station and moves it to another line, sending only what changed", async () => {
    const session = adminSession();
    const other = LINES[2];
    if (!other) throw new Error("no second line");
    session.api.updateDevice.mockResolvedValue({ ...HOST_PC, name: "Станция 1", lineId: other.id });
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: " Станция 1 " } });
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: other.id } });
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", HOST_PC.id, { name: "Станция 1", lineId: other.id }],
    ]);
    expect(within(rowOf("Станция 1")).getByText("Линия 2")).toBeTruthy();
  });

  it("takes a station off its line with null", async () => {
    const session = adminSession();
    session.api.updateDevice.mockResolvedValue({ ...HOST_PC, lineId: null });
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: "" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", HOST_PC.id, { lineId: null }],
    ]);
  });

  it("offers the active lines by name and keeps a station's archived line as it is", async () => {
    const session = adminSession();
    session.api.updateDevice.mockResolvedValue({ ...PACKING, name: "Упаковка" });
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить устройство «Станция упаковки»" }));
    const line = screen.getByLabelText("Линия");
    expect(optionLabels(line)).toEqual([
      "Не выбрана",
      "Линия 1",
      "Линия 2",
      "Линия 10",
      "Линия 5 (в архиве)",
    ]);
    expect(line).toHaveProperty("value", ARCHIVED_LINE_ID);
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Упаковка" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", PACKING.id, { name: "Упаковка" }],
    ]);
  });

  it("has no line to choose for a device that is not a station", async () => {
    const session = adminSession();
    session.api.updateDevice.mockResolvedValue({ ...OFFICE_PC, name: "Офис склада" });
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить устройство «Офис бухгалтерии»" }));
    expect(screen.queryByLabelText("Линия")).toBeNull();
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Офис склада" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", OFFICE_PC.id, { name: "Офис склада" }],
    ]);
  });

  it("checks the name like the host before sending", async () => {
    const session = adminSession();
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Станция\t1" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите имя, до 100 символов")).toBeTruthy();
    expect(session.api.updateDevice).not.toHaveBeenCalled();
  });

  it("puts a line the host would not take under the line", async () => {
    const session = adminSession();
    session.api.updateDevice.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no such active line",
        details: { field: "lineId" },
      }),
    );
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: LINES[1]?.id ?? "" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    const message = await screen.findByText(
      "Хост не принял эту линию: её могли убрать в архив. Выберите другую.",
    );
    expect(screen.getByLabelText("Линия").getAttribute("aria-describedby")).toBe(message.id);
  });

  it("revokes a device after a confirmation that names it and says it cannot be undone", async () => {
    const session = adminSession();
    const revoked = { ...PACKING, revokedAt: "2026-09-28T10:00:00Z" };
    session.api.revokeDevice.mockResolvedValue(revoked);
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Отозвать устройство «Станция упаковки»" }));
    expect(
      within(dialog()).getByText(
        "Устройство «Станция упаковки» больше не сможет обращаться к хосту, его сессии офиса закроются. Отменить отзыв нельзя: чтобы снова работать на этом устройстве, подключите его заново.",
      ),
    ).toBeTruthy();
    const reads = session.api.listDevices.mock.calls.length;
    session.api.listDevices.mockResolvedValue([HOST_PC, revoked, OFFICE_PC, RETIRED]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Устройство «Станция упаковки» отозвано.")).toBeTruthy();
    expect(session.api.revokeDevice.mock.calls).toStrictEqual([
      ["office-session-token", PACKING.id],
    ]);
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
    await waitFor(() =>
      expect(within(rowOf("Станция упаковки")).getByText("Отозвано")).toBeTruthy(),
    );
    expect(within(rowOf("Станция упаковки")).queryByRole("button")).toBeNull();
  });

  it("explains a revocation the host refused, in the dialog", async () => {
    const session = adminSession();
    session.api.revokeDevice.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such device" }),
    );
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Отозвать устройство «Станция упаковки»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await within(dialog()).findByText("Запись не найдена.")).toBeTruthy();
  });

  it("shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(30));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    const matrix = await within(pairing).findByRole("img", { name: "Код подключения для сканера" });
    expect(matrix.querySelector("svg")).not.toBeNull();
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(within(pairing).getByText("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB")).toBeTruthy();
    expect(within(pairing).getByText("10.0.0.5:45710, 192.168.1.10:45710")).toBeTruthy();
    // A fresh code always starts a full local countdown: its lifetime comes
    // from the host, but it counts from when this PC asked, not from the
    // host's `createdAt`, so `secondsAgo` above (30) does not shift it.
    expect(within(pairing).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    expect(
      within(pairing).getByText(
        "После пяти неверных попыток с любого устройства код перестаёт действовать. Если устройство пишет, что код неверен, создайте новый.",
      ),
    ).toBeTruthy();
    // No code was on screen: the request has no body.
    expect(session.api.createPairingCode.mock.calls).toStrictEqual([["office-session-token"]]);
  });

  it.each([
    ["ahead of", -60 * 60],
    ["behind", 60 * 60],
  ])(
    "shows a fresh 10:00 countdown even when the host clock is an hour %s this PC's",
    async (_direction, secondsAgo) => {
      const session = adminSession();
      session.api.createPairingCode.mockResolvedValue(pairingCode(secondsAgo));
      await openDevices(session);
      fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
      const pairing = await screen.findByRole("dialog");
      expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();
      expect(within(pairing).queryByText("Срок кода истёк. Создайте новый код.")).toBeNull();
      expect(within(pairing).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    },
  );

  it("counts the lifetime the host gives the code, from the moment this PC asked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    // Five minutes by the host's clock, whose times need not match this
    // PC's clock at all: only the duration counts. (Later than every
    // device's `pairedAt`, as a real code is, so no device reads as joined.)
    session.api.createPairingCode.mockResolvedValue({
      ...pairingCode(0),
      createdAt: "2026-09-28T08:00:00Z",
      expiresAt: "2026-09-28T08:05:00Z",
    });
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText(/^Код действует ещё (05:00|04:59)$/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(await screen.findByText("Срок кода истёк. Создайте новый код.")).toBeTruthy();
  });

  it("offers a new code once the code expired, and it replaces the expired one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    // `mockImplementationOnce`, not `mockResolvedValueOnce`: the latter would
    // evaluate both `pairingCode(0)` calls right now, before the 10-minute
    // advance below, so the second code's `expiresAt` would already be stale
    // by the time it is requested. Each call must build its own code fresh,
    // relative to the clock at the moment the host is actually asked.
    session.api.createPairingCode
      .mockImplementationOnce(() => Promise.resolve(pairingCode(0)))
      .mockImplementationOnce(() => Promise.resolve(pairingCode(0)));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    // Only this PC's own elapsed time can expire a freshly received code
    // (fix round 1, item 1): wait out the full local countdown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });
    expect(await screen.findByText("Срок кода истёк. Создайте новый код.")).toBeTruthy();
    expect(screen.queryByText("7K3MQ 9XV2D")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Новый код" }));
    expect(await screen.findByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(session.api.createPairingCode.mock.calls).toStrictEqual([
      ["office-session-token"],
      ["office-session-token", { replaces: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d" }],
    ]);
  });

  it("asks for one code on a double click, from the page and from the dialog", async () => {
    const session = adminSession();
    const answers: Array<(code: PairingCode) => void> = [];
    session.api.createPairingCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    await openDevices(session);
    const add = screen.getByRole("button", { name: "Подключить устройство" });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(session.api.createPairingCode).toHaveBeenCalledTimes(1));
    // Exactly once: let every pending task settle, then look again.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.createPairingCode).toHaveBeenCalledTimes(1);
    await act(async () => {
      answers[0]?.(pairingCode(0));
    });
    const pairing = await screen.findByRole("dialog");
    const regenerate = within(pairing).getByRole("button", { name: "Новый код" });
    fireEvent.click(regenerate);
    fireEvent.click(regenerate);
    await waitFor(() => expect(session.api.createPairingCode).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
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
    session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(await screen.findByText("Устройство «Станция на линии 2» подключено.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("Станция на линии 2")).toBeTruthy();
  });

  it("closes on a join even when this PC's clock is skewed from the host's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Fixed host-clock timestamps, independent of this PC's clock: the host
    // created the code at 09:50 UTC and it lives until 10:00.
    const code: PairingCode = {
      id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
      code: "7K3MQ9XV2D",
      createdAt: "2026-09-27T09:50:00.000Z",
      expiresAt: "2026-09-27T10:00:00.000Z",
      payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
    };
    // This PC's own clock reads an hour ahead of the host's. Join detection
    // must still work: it compares the host's `createdAt` with the host's
    // `pairedAt` and never reads this PC's clock.
    vi.setSystemTime(new Date("2026-09-27T10:50:00.000Z"));
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(code);
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    await screen.findByRole("dialog");
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция при разъехавшихся часах",
      lineId: null,
      pairedAt: "2026-09-27T09:51:00.000Z", // one minute after createdAt, by the host's own clock
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      await screen.findByText("Устройство «Станция при разъехавшихся часах» подключено."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads the list again when the dialog is closed", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    const reads = session.api.listDevices.mock.calls.length;
    // The footer button; the × in the title bar is named «Закрыть» too.
    fireEvent.click(within(pairing).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
  });

  it("does not reopen once closed while a new code was still on its way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    // The "Новый код" request from inside the dialog never resolves until we
    // say so.
    let resolveSecond: (code: PairingCode) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    fireEvent.click(within(pairing).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The abandoned request finally answers: it must not reopen the dialog.
    await act(async () => {
      resolveSecond(pairingCode(0));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the join notice when a device joins while a new code was still on its way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    let resolveSecond: (code: PairingCode) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция во время перевыпуска",
      lineId: null,
      pairedAt: new Date(Date.now() + 1000).toISOString(),
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      await screen.findByText("Устройство «Станция во время перевыпуска» подключено."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The abandoned second code finally answers; it must not reopen the
    // dialog or replace the notice the user already saw.
    await act(async () => {
      resolveSecond(pairingCode(0));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Устройство «Станция во время перевыпуска» подключено.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no stray failure when a request abandoned by closing the dialog later fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    let rejectSecond: (error: unknown) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    fireEvent.click(within(pairing).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The abandoned request finally fails: it must not show a page-level
    // error for an action nobody is looking at anymore.
    await act(async () => {
      rejectSecond(
        new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Недостаточно прав для этого действия.")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("replaces the old code and restarts the countdown when a new one is requested while one is live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    let pairing = await screen.findByRole("dialog");
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();

    // Two minutes into the first code's countdown: both codes being fresh
    // would make the final assertion below hold either way, so this advance
    // is what makes it actually prove a restart, not just a fresh display.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    expect(within(pairing).queryByText(/^Код действует ещё (10:00|09:59)$/)).toBeNull();

    const secondCode: PairingCode = {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      code: "AAAAABBBBB",
      createdAt: pairingCode(0).createdAt,
      expiresAt: pairingCode(0).expiresAt,
      payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=AAAAABBBBB`,
    };
    session.api.createPairingCode.mockResolvedValueOnce(secondCode);
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    pairing = await screen.findByRole("dialog");
    expect(await within(pairing).findByText("AAAAA BBBBB")).toBeTruthy();
    expect(within(pairing).queryByText("7K3MQ 9XV2D")).toBeNull();
    expect(within(pairing).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    // «Новый код» named the code on screen, so the host ends it at once.
    expect(session.api.createPairingCode.mock.calls).toStrictEqual([
      ["office-session-token"],
      ["office-session-token", { replaces: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d" }],
    ]);
  });

  it("shows a failed regenerate's error inside the dialog and keeps the old code", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();

    session.api.createPairingCode.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    expect(await within(pairing).findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    // The old code is still there: a failed regenerate does not blank the dialog.
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("encodes the DataMatrix once and reuses it while the countdown ticks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const encode = vi.mocked(renderLiteralDataMatrixSvg);
    encode.mockClear();
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    // The dialog itself is not enough to wait for: `PairingDataMatrix` loads
    // behind a `Suspense` fallback, so when this test runs alone (nothing
    // has warmed up that lazy chunk yet) the dialog can appear before any
    // encoding has happened. Waiting for the image is not quite enough
    // either -- the first mount while the chunk is loading can still run the
    // memo more than once -- so this records whatever it took to get there
    // and only checks that ticking the countdown afterward adds no more.
    await within(pairing).findByRole("img", { name: "Код подключения для сканера" });
    const shown = encode.mock.calls.length;
    expect(shown).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // five countdown ticks, no re-encode
    });
    expect(encode).toHaveBeenCalledTimes(shown);
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

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx`
Expected: FAIL — 13 тестов из 27:

- «lists the devices, naming lines from the host's list» — `Unable to find an element with the text: Линия 1`: страница ещё читает локальные копии;
- 8 тестов правки и отзыва — нет кнопок `Изменить устройство «…»` и `Отозвать устройство «…»`;
- «counts the lifetime the host gives the code…» — `Unable to find an element with the text: /^Код действует ещё (05:00|04:59)$/`: срок ещё берётся из `CODE_LIFETIME_MS`;
- «offers a new code once the code expired…» и «replaces the old code…» — `expected [ [ 'office-session-token' ], …(1) ] to strictly equal …`: `replaces` не уходит;
- «asks for one code on a double click…» — `expected "vi.fn()" to be called 2 times, but got 3 times`.

- [ ] **Step 3: Диалоги, страница, код подключения и тексты**

1. Create `apps/standalone/src/office/devices/line-label.ts`:

```ts
import type { TFunction } from "i18next";

import type { OfficeLine } from "../../host/protocol.js";

/**
 * How the office names a device's line: none; its name, marked when the line
 * is archived (a station stays on its line when the line is archived); or
 * the start of its id when the host's list does not know it.
 */
export function lineLabel(
  lines: readonly OfficeLine[],
  lineId: string | null,
  t: TFunction,
): string {
  if (lineId === null) return t("office.common.none");
  const line = lines.find((each) => each.id === lineId);
  if (line === undefined) return `${lineId.slice(0, 8)}…`;
  return line.archived ? t("office.common.archivedName", { name: line.name }) : line.name;
}
```

2. Create `apps/standalone/src/office/devices/DeviceDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input, Select } from "@markiro/ui";

import type { DeviceRecord, OfficeLine } from "../../host/protocol.js";
import { deviceUpdate } from "../../host/requests.js";
import { deviceNameRule } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { lineLabel } from "./line-label.js";

/** `lineId` is the chosen line's id, or `""` for none. */
const deviceFieldsSchema = z.object({ name: deviceNameRule, lineId: z.string() });
type DeviceFields = z.input<typeof deviceFieldsSchema>;

/** The host refuses a line that is archived or gone (`no such active line`). */
const DEVICE_FIELDS = {
  name: "name",
  lineId: { field: "lineId", message: "office.devices.errors.lineRejected" },
} as const;

export interface DeviceDialogProps {
  device: DeviceRecord;
  /** The host's lines, archived ones included (`GET /v1/office/lines`). */
  lines: readonly OfficeLine[];
  onClose: () => void;
  onSaved: (device: DeviceRecord) => void;
}

/**
 * Renames a device and, for a station, sets its line. Only the fields that
 * changed are sent (`deviceUpdate`). A line can be chosen only among the
 * active ones; a station's current line stays on the list even when it has
 * been archived since, and keeping it sends nothing for the line.
 */
export function DeviceDialog({ device, lines, onClose, onSaved }: DeviceDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: DeviceFields) =>
    api.updateDevice(
      token,
      device.id,
      deviceUpdate(device, {
        name: values.name,
        lineId: values.lineId === "" ? null : values.lineId,
      }),
    ),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<DeviceFields>({
    resolver: zodResolver(deviceFieldsSchema),
    defaultValues: { name: device.name, lineId: device.lineId ?? "" },
  });

  const options: { value: string; label: string }[] = [
    { value: "", label: t("office.devices.noLine") },
    ...activeFirstByName(lines.filter((line) => !line.archived)).map((line) => ({
      value: line.id,
      label: line.name,
    })),
  ];
  if (device.lineId !== null && !options.some((option) => option.value === device.lineId)) {
    options.push({ value: device.lineId, label: lineLabel(lines, device.lineId, t) });
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await save.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, DEVICE_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.devices.editTitle", { name: device.name })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        label={t("office.devices.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      {device.kind === "station" && (
        <Controller
          control={control}
          name="lineId"
          render={({ field }) => (
            <Select
              native
              label={t("office.devices.fields.line")}
              hint={t("office.devices.fields.lineHint")}
              options={options}
              value={field.value}
              onValueChange={field.onChange}
              {...fieldError(errors.lineId?.message)}
            />
          )}
        />
      )}
    </FormDialog>
  );
}
```

3. Create `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DeviceRecord } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface RevokeDeviceDialogProps {
  device: DeviceRecord;
  onClose: () => void;
  onRevoked: (device: DeviceRecord) => void;
}

/**
 * Asks before a device is revoked: its key stops working at once and its
 * office sessions end. There is no way back; the device pairs again as a
 * new one.
 */
export function RevokeDeviceDialog({ device, onClose, onRevoked }: RevokeDeviceDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const revoke = useOfficeMutation((api, token, _variables: void) =>
    api.revokeDevice(token, device.id),
  );

  const submit = async () => {
    setFailure(null);
    try {
      onRevoked(await revoke.mutateAsync());
    } catch (error) {
      setFailure(alertFailure(error));
    }
  };

  return (
    <FormDialog
      title={t("office.devices.revokeTitle")}
      submitLabel={t("office.devices.revokeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.devices.revokeBody", { name: device.name })}</p>
    </FormDialog>
  );
}
```

4. Заменить содержимое `apps/standalone/src/office/devices/DevicesPage.tsx` целиком:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { DeviceRecord, PairingCode } from "../../host/protocol.js";
import { pairingCodeRequest } from "../../host/requests.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { DeviceDialog } from "./DeviceDialog.js";
import { lineLabel } from "./line-label.js";
import { codeLifetimeMs, PairingCodeDialog } from "./PairingCodeDialog.js";
import { RevokeDeviceDialog } from "./RevokeDeviceDialog.js";

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });

interface Pairing {
  code: PairingCode;
  /** When the host created the code, by its clock: a device paired since took the code. */
  issuedAt: number;
  /**
   * When the dialog stops showing the code, by this PC's own clock:
   * `requestedAt` (captured just before the request was sent — see
   * `newCode`) plus the code's lifetime by the host (`codeLifetimeMs`). The
   * office can run on a PC other than the host, and a cloud-less LAN site
   * cannot promise the two clocks agree, so only the duration crosses over:
   * no host timestamp is ever compared with this PC's clock.
   */
  deadline: number;
}

type DevicesDialog =
  { kind: "edit"; device: DeviceRecord } | { kind: "revoke"; device: DeviceRecord };

/**
 * Paired devices and pairing codes (spec §5.5, administrators only; the
 * route is wrapped in `RequireRole`). Line names come from the host's list,
 * which the edit dialog offers too: a line added a moment ago can be chosen
 * at once, and the table and the dialog name lines alike.
 */
export function DevicesPage() {
  const { t } = useTranslation();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const storeDevice = useStoreRecord<DeviceRecord>(officeKeys.devices);
  const create = useOfficeMutation((api, token, replaces: string | null) =>
    replaces === null
      ? api.createPairingCode(token)
      : api.createPairingCode(token, pairingCodeRequest(replaces)),
  );
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DevicesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The dialog closes itself once a device paired after its code was issued.
  const joined =
    pairing === null
      ? undefined
      : devices.data?.find((device) => Date.parse(device.pairedAt) >= pairing.issuedAt);
  const dialogOpen = pairing !== null && joined === undefined;

  // A request still in flight when the dialog closes -- by a click on
  // "Закрыть", Escape, or because a device joined while a fresh code was
  // being requested -- must not act on its answer: reopening the dialog
  // with a code nobody asked to see anymore, or showing a stray failure for
  // an abandoned action. This effect runs whenever `dialogOpen` changes
  // value, not on every render, bumping the generation each time the new
  // value is `false` -- including its first run at mount, before any
  // request exists, which is harmless. It relies on React flushing passive
  // effects synchronously for the commit that flips `dialogOpen`: a click
  // or an Escape keydown commits on the synchronous lane, and so does the
  // `useSyncExternalStore` update React Query uses to publish a fresh poll
  // result (the joined device arriving) -- in both cases the bump has
  // already happened by the time a pending request's `await` settles.
  const requestGeneration = useRef(0);
  useEffect(() => {
    if (!dialogOpen) requestGeneration.current++;
  }, [dialogOpen]);
  // A code request is on its way: another click asks for nothing, so a
  // double click leaves one live code, not two. The mutation's own
  // `isPending`, which disables the buttons, reaches React a tick later.
  const requesting = useRef(false);

  const newCode = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setFailure(null);
    setNotice(null);
    // «Новый код» names the code on screen, and the host ends it at once;
    // with no code on screen the request has no body.
    const shown = pairing !== null && dialogOpen ? pairing.code.id : null;
    // A new attempt from the page drops the last notice.
    if (!dialogOpen) setPairing(null);
    const generation = ++requestGeneration.current;
    // Captured before the request, not after it resolves: the host stamps
    // the code's times before a database write that can wait up to its 5 s
    // busy timeout, so a deadline taken after the answer arrives could read
    // later than the host's own expiry. Taking the local time first keeps
    // this PC's deadline at or before the host's.
    const requestedAt = Date.now();
    try {
      const code = await create.mutateAsync(shown);
      if (generation !== requestGeneration.current) return;
      setPairing({
        code,
        issuedAt: Date.parse(code.createdAt),
        deadline: requestedAt + codeLifetimeMs(code),
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setFailure(errorMessageKey(error));
    } finally {
      requesting.current = false;
    }
  };

  const close = () => {
    setPairing(null);
    setFailure(null);
    void devices.refetch();
  };

  const open = (next: DevicesDialog) => {
    // A code still on its way must not open its dialog over this one.
    requestGeneration.current++;
    setPairing(null);
    setFailure(null);
    setNotice(null);
    setDialog(next);
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
      render: (device) => lineLabel(lines.data ?? [], device.lineId, t),
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
    {
      // A revoked device is a dead record: its key is refused for good and a
      // new pairing makes a new device, so it offers nothing to change.
      key: "actions",
      title: t("office.devices.table.actions"),
      render: (device) =>
        device.revokedAt === null ? (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.devices.editNamed", { name: device.name })}
              onClick={() => open({ kind: "edit", device })}
            >
              {t("office.devices.edit")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.devices.revokeNamed", { name: device.name })}
              onClick={() => open({ kind: "revoke", device })}
            >
              {t("office.devices.revoke")}
            </Button>
          </RowActions>
        ) : null,
    },
  ];

  const content = () => {
    if (devices.isPending || lines.isPending) return <PageLoading />;
    if (devices.isError) {
      return <LoadError error={devices.error} onRetry={() => void devices.refetch()} />;
    }
    if (lines.isError) {
      return <LoadError error={lines.error} onRetry={() => void lines.refetch()} />;
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
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && !dialogOpen && <Alert tone="error">{t(failure)}</Alert>}
      {content()}
      {pairing && dialogOpen && (
        <PairingCodeDialog
          code={pairing.code}
          deadline={pairing.deadline}
          regenerating={create.isPending}
          failure={failure}
          onRegenerate={() => void newCode()}
          onClose={close}
        />
      )}
      {dialog?.kind === "edit" && (
        <DeviceDialog
          device={dialog.device}
          lines={lines.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={(device) => {
            storeDevice(device);
            setDialog(null);
            setNotice(t("office.common.saved"));
          }}
        />
      )}
      {dialog?.kind === "revoke" && (
        <RevokeDeviceDialog
          device={dialog.device}
          onClose={() => setDialog(null)}
          onRevoked={(device) => {
            setDialog(null);
            setNotice(t("office.devices.revoked", { name: device.name }));
            void devices.refetch();
          }}
        />
      )}
    </>
  );
}
```

5. В `apps/standalone/src/office/devices/PairingCodeDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
/** How often the device list is read while a code is shown. */
export const DEVICE_POLL_MS = 3000;

/** How long a code lives once requested (`pairing_code::CODE_LIFETIME`, spec §4.7). */
export const CODE_LIFETIME_MS = 10 * 60 * 1000;

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
```

заменить на

<!-- prettier-ignore -->
```tsx
/** How often the device list is read while a code is shown. */
export const DEVICE_POLL_MS = 3000;

/**
 * How long a code lives, by the host's own clock: `expiresAt − createdAt`.
 * Only this duration crosses to this PC's clock (`DevicesPage` adds it to the
 * moment the code was requested); neither timestamp is ever compared with
 * this PC's `Date.now()`.
 */
export function codeLifetimeMs(code: Pick<PairingCode, "createdAt" | "expiresAt">): number {
  return Math.max(0, Date.parse(code.expiresAt) - Date.parse(code.createdAt));
}

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
```

6. В `apps/standalone/src/office/devices/PairingCodeDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

/**
 * Milliseconds until `deadline`, ticking every second (after the admin's
 * pairing panel). `deadline` is this PC's own clock reading
 * (`requestedAt + CODE_LIFETIME_MS`, captured in `DevicesPage` just before
 * the request is sent, not after it resolves), never the host's
 * `expiresAt`: the office can run on a PC other than the host, and a
 * cloud-less LAN site cannot promise the two clocks agree. Comparing the
 * host's timestamp against this PC's `Date.now()` would make the countdown
 * wrong by however far the clocks have drifted — showing an already-expired
 * fresh code, or a many-hours-long one. Clamped to `CODE_LIFETIME_MS`: right
 * after a fresh `deadline` arrives, this hook can still be rendering with a
 * `now` reading from the previous tick, up to a second old, which would
 * otherwise read as "10:01" for that one frame.
 */
function useRemainingMs(deadline: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.min(deadline - now, CODE_LIFETIME_MS));
}

export interface PairingCodeDialogProps {
```

заменить на

<!-- prettier-ignore -->
```tsx

/**
 * Milliseconds until `deadline`, ticking every second (after the admin's
 * pairing panel). `deadline` is this PC's own clock reading (`requestedAt +
 * lifetime`, captured in `DevicesPage` just before the request is sent, not
 * after it resolves), never the host's `expiresAt`: the office can run on a
 * PC other than the host, and a cloud-less LAN site cannot promise the two
 * clocks agree. Comparing the host's timestamp against this PC's
 * `Date.now()` would make the countdown wrong by however far the clocks have
 * drifted — showing an already-expired fresh code, or a many-hours-long one.
 * Clamped to `lifetime`: right after a fresh `deadline` arrives, this hook
 * can still be rendering with a `now` reading from the previous tick, up to
 * a second old, which would otherwise read as "10:01" for that one frame.
 */
function useRemainingMs(deadline: number, lifetime: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.min(deadline - now, lifetime));
}

export interface PairingCodeDialogProps {
```

7. В `apps/standalone/src/office/devices/PairingCodeDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    refetchInterval: DEVICE_POLL_MS,
  });
  const remainingMs = useRemainingMs(deadline);
  const payload = parsePairingPayload(code.payload);
  const details: DefinitionGridItem[] = [];
  if (payload !== null) {
```

заменить на

<!-- prettier-ignore -->
```tsx
  useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    refetchInterval: DEVICE_POLL_MS,
  });
  const remainingMs = useRemainingMs(deadline, codeLifetimeMs(code));
  const payload = parsePairingPayload(code.payload);
  const details: DefinitionGridItem[] = [];
  if (payload !== null) {
```

8. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
  /** Line names from this installation's local copies, not from the host. */
  lineNames: ["office", "line-names"],
} as const;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
} as const;

/**
```

9. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { OfficeLinkProvider } from "./office-link.js";
import { OfficeLocalProvider } from "./office-local.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";
```

заменить на

<!-- prettier-ignore -->
```tsx

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";
```

10. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  link?: HostStatus | null;
  /** The reference sync, shown in the header with the link; `null` outside the app. */
  sync?: SyncState | null;
  /** This installation's local copies; «Устройства» names lines from them. */
  local?: LocalExecutor | null;
  /**
   * The latest revision the host announced (`null` before the first). When
   * it changes, the signed-in user is read again, so a new name or role
```

заменить на

<!-- prettier-ignore -->
```tsx
  link?: HostStatus | null;
  /** The reference sync, shown in the header with the link; `null` outside the app. */
  sync?: SyncState | null;
  /**
   * The latest revision the host announced (`null` before the first). When
   * it changes, the signed-in user is read again, so a new name or role
```

11. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({
  session,
  link = null,
  sync = null,
  local = null,
  hostRevision = null,
}: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  const shownRevision = useRef(hostRevision);
```

заменить на

<!-- prettier-ignore -->
```tsx
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({ session, link = null, sync = null, hostRevision = null }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  const shownRevision = useRef(hostRevision);
```

12. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <OfficeLinkProvider value={officeLink}>
          <OfficeLocalProvider value={local}>
            <RouterProvider router={router} />
          </OfficeLocalProvider>
        </OfficeLinkProvider>
      </OfficeSessionProvider>
    </QueryClientProvider>
```

заменить на

<!-- prettier-ignore -->
```tsx
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <OfficeLinkProvider value={officeLink}>
          <RouterProvider router={router} />
        </OfficeLinkProvider>
      </OfficeSessionProvider>
    </QueryClientProvider>
```

13. Удалить `apps/standalone/src/office/office-local.tsx`: `git rm apps/standalone/src/office/office-local.tsx`. После правки `Office.tsx` его никто не импортирует.

14. В `apps/standalone/src/app/App.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        session={officeSession}
        link={state.link}
        sync={state.sync}
        local={localDb}
        hostRevision={state.hostRevision}
      />
    );
```

заменить на

<!-- prettier-ignore -->
```tsx
        session={officeSession}
        link={state.link}
        sync={state.sync}
        hostRevision={state.hostRevision}
      />
    );
```

15. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "none": "—",
      "readOnly": "Изменять эти данные может только администратор.",
      "active": "Действует",
      "archived": "В архиве"
    },
    "org": {
      "title": "Профиль организации",
```

заменить на

<!-- prettier-ignore -->
```json
      "none": "—",
      "readOnly": "Изменять эти данные может только администратор.",
      "active": "Действует",
      "archived": "В архиве",
      "archivedName": "{{name}} (в архиве)"
    },
    "org": {
      "title": "Профиль организации",
```

16. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "line": "Линия",
        "pairedAt": "Подключено",
        "lastSeenAt": "Последний раз",
        "status": "Доступ"
      },
      "kinds": {
        "station": "Станция",
```

заменить на

<!-- prettier-ignore -->
```json
        "line": "Линия",
        "pairedAt": "Подключено",
        "lastSeenAt": "Последний раз",
        "status": "Доступ",
        "actions": "Действия"
      },
      "kinds": {
        "station": "Станция",
```

17. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "status": {
        "active": "Действует",
        "revoked": "Отозвано"
      },
      "pairing": {
        "title": "Подключение устройства",
```

заменить на

<!-- prettier-ignore -->
```json
      "status": {
        "active": "Действует",
        "revoked": "Отозвано"
      },
      "edit": "Изменить",
      "editNamed": "Изменить устройство «{{name}}»",
      "revoke": "Отозвать",
      "revokeNamed": "Отозвать устройство «{{name}}»",
      "editTitle": "Устройство «{{name}}»",
      "fields": {
        "name": "Имя",
        "line": "Линия",
        "lineHint": "Станция перейдёт на линию, как только получит изменение от хоста. Без линии она попросит выбрать линию."
      },
      "noLine": "Не выбрана",
      "revokeTitle": "Отозвать устройство?",
      "revokeBody": "Устройство «{{name}}» больше не сможет обращаться к хосту, его сессии офиса закроются. Отменить отзыв нельзя: чтобы снова работать на этом устройстве, подключите его заново.",
      "revokeSubmit": "Отозвать",
      "revoked": "Устройство «{{name}}» отозвано.",
      "errors": {
        "lineRejected": "Хост не принял эту линию: её могли убрать в архив. Выберите другую."
      },
      "pairing": {
        "title": "Подключение устройства",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем она же с `--reporter=verbose`.
Expected: PASS — 27 тестов; stderr пуст.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Office pages», фрагмент

<!-- prettier-ignore -->
```text
  password goes through «Сменить пароль» with the current password.
- An ended session unmounts the office: unsaved edits are lost, and the next
  sign-in starts at «Обзор».
- «Устройства» lists `GET /v1/office/devices`; line names come from this
  installation's local copies (`useQuery` with `officeKeys.lineNames` — a
  local read, not a host request), and `lastSeenAt` is «Последний раз»,
  never «на связи»: the host touches it at most once a minute and a stream
  only when it opens. A claim raises no revision, so the pairing-code
  dialog reads the list every 3 s (`DEVICE_POLL_MS`) and closes once a
  device paired after the code was issued appears. The DataMatrix encoder
  loads lazily (`PairingDataMatrix`); when it fails, the typed code, the
  fingerprint and the host's addresses stay the way to pair. The code's own
  countdown runs on this PC's clock from the moment the code was requested,
  since the host and the office PCs on a cloud-less LAN are not promised to
  agree on the time; join detection compares host timestamps only.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
  password goes through «Сменить пароль» with the current password.
- An ended session unmounts the office: unsaved edits are lost, and the next
  sign-in starts at «Обзор».
- «Устройства» lists `GET /v1/office/devices` and names lines from
  `GET /v1/office/lines`, the list its edit dialog offers, so a line added a
  moment ago can be chosen at once; an archived line is marked «в архиве».
  `lastSeenAt` is «Последний раз», never «на связи»: the host touches it at
  most once a minute and a stream only when it opens. One dialog renames a
  device and sets a station's line, sending only what changed
  (`deviceUpdate`): only an active line can be chosen, and a station's
  current line stays on the list even when archived. A revoked device is a
  dead record and offers no controls; revoking asks first, names the device
  and says it cannot be undone, then the list is read again. A claim raises
  no revision, so the pairing-code dialog reads the list every 3 s
  (`DEVICE_POLL_MS`) and closes once a device paired after the code was
  created appears. «Новый код» sends the code on screen as `{ replaces }`
  (no code on screen, no body), and a second click while a code is on its
  way asks for nothing. The DataMatrix encoder loads lazily
  (`PairingDataMatrix`); when it fails, the typed code, the fingerprint and
  the host's addresses stay the way to pair. The countdown takes the code's
  lifetime from the host (`codeLifetimeMs`: `expiresAt − createdAt`) and
  counts it on this PC's clock from the moment the code was requested: the
  host and the office PCs on a cloud-less LAN are not promised to agree on
  the time, so no host timestamp is compared with this PC's clock, and join
  detection compares host timestamps only.

## Marking rules

```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.5, фрагмент

<!-- prettier-ignore -->
```text
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
  поднимает ревизию, и событие потока о нём не приходит. Диалог закрывается сам,
  когда появляется устройство, подключённое после выдачи кода. «Последний раз» —
  время последнего запроса устройства, а не признак связи. План 1c даёт список и
  диалог; переименование, линию и отзыв — план 1d.

### 5.6. Цех

```

заменить на

<!-- prettier-ignore -->
```text
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
  поднимает ревизию, и событие потока о нём не приходит. Диалог закрывается сам,
  когда появляется устройство, подключённое после выдачи кода. «Последний раз» —
  время последнего запроса устройства, а не признак связи. План 1c3 дал список и
  диалог, план 1d3 — остальное:
  - имя и линия меняются одним диалогом, на хост уходят только изменённые поля;
    линия есть только у станции, выбрать можно только активную, а текущая линия
    станции остаётся в списке и после архивирования (с пометкой «в архиве»);
    названия линий в таблице и в диалоге — из `GET /v1/office/lines` хоста;
  - отзыв спрашивает подтверждение, называет устройство и говорит, что его нельзя
    отменить; у отозванного устройства кнопок нет;
  - «Новый код» шлёт `{ replaces }` с кодом на экране (без кода на экране — без
    тела), а повторный щелчок, пока запрос идёт, ничего не отправляет; таймер
    берёт срок жизни кода у хоста (`expiresAt − createdAt`) и отсчитывает его по
    часам этого ПК от момента запроса.

### 5.6. Цех

```

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`, `… build`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 32 файла, 614 тестов; `grep -rn "useOfficeLocal\|lineNames\|CODE_LIFETIME_MS" apps/standalone/src apps/standalone/test` ничего не находит.

```bash
git add apps/standalone/src/office/devices/line-label.ts apps/standalone/src/office/devices/DeviceDialog.tsx apps/standalone/src/office/devices/RevokeDeviceDialog.tsx apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/PairingCodeDialog.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/Office.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/devices-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): «Устройства» — правка, отзыв, «Новый код» с replaces и срок кода от хоста" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`office-local.tsx` уже снят с учёта командой `git rm` в шаге 3.

### Task 7: Станция подхватывает линию, назначенную в офисе — `device_refresh`

Итоговое ревью плана 1d2 (важное замечание I-1): назначение линии в офисе берёт ревизию хоста, но записи ленты не порождает. Станция держит линию в `device.json`, и пишет туда только её собственный `PUT /v1/device/line`. Поэтому станция о назначении не узнаёт, а позже молча затирает его своим выбором. Хост уже будит потоки, когда линия станции действительно меняется; станция должна перечитать своё устройство.

- **Rust.** `DeviceState::refresh()` читает `GET /v1/device` с ключом устройства под той же блокировкой `pairing`, что подключение, сброс и `select_line`. Ответ разбирается как `DeviceInfo`; если линия другая, она сохраняется в `device.json` и в подключении в памяти. Хвост общий с `select_line` — `keep_line`. `401` — `key_rejected`; хост недоступен — `unreachable`, и ничего не меняется: без хоста станция остаётся на своей линии. Команда `device_refresh` — в `lib.rs` и в списке `invoke_handler`.
- **Вебвью.**
  - `deviceApi.refresh` — свойство-функция: `useHostLink` берёт её несвязанной.
  - Действие `device_refreshed` меняет `device.status`, как `line_selected`, но только для того же подключения и только если линия другая.
  - `useHostLink` вызывает `refresh` после первого запуска синхронизации и на каждое событие ревизии, через `createSyncScheduler`: одно чтение за раз, события во время чтения дают ровно одно следующее.
  - Отказ ключа или смена сертификата — экран отказа, как везде (`deviceRejection`, им же теперь пользуется `selectLine` в `App`). Остальные ошибки тихо ждут следующего события.
- **Снятая и назначенная линия.** Снятая линия (`null`) возвращает станцию на выбор линии — прежнее правило `nextShellView` для станции без линии; назначенная — переводит на неё. Что это значит для идущей смены — решение плана 2a; на этапе 1 цех — заглушка.

Тесты:

- Rust (`src-tauri/tests/line.rs`):
  - линия сменилась и пережила перезапуск;
  - та же линия — `device.json` не переписан: на Unix тот же inode, файл заменяется переименованием;
  - линию сняли;
  - хоста нет;
  - ключ не узнан;
  - нет подключения;
  - сброс во время чтения не возвращает `device.json`;
  - чтение и выбор линии в один момент.
- IPC (`src-tauri/tests/ipc.rs`) — `device_refresh` без аргументов отдаёт `DeviceStatus`; без подключения — `not_paired`.
- Вебвью — привязка (`device.test.ts`), действие и `deviceRejection` (`shell.test.ts`), хук через `App` (`app.test.tsx`): снятие и назначение линии, одно чтение на событие и склейка событий во время чтения, отказ ключа и сертификата, недоступный хост.

Сериализацию с `forget` тест доказывает детерминированно: без блокировки в `refresh` ответ хоста приходит после сброса и снова пишет `device.json`. Тест «чтение и выбор линии» проверяет инвариант (хост, память и файл сходятся) в шести раундах, но без блокировки может и пройти: гонку он ловит лишь вероятностно.

**Files:**

- Modify: `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/tests/line.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/src/host/device.ts`, `apps/standalone/src/app/{shell.ts,host-link.ts,App.tsx}`, `apps/standalone/test/{device.test.ts,shell.test.ts,app.test.tsx}`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§4.4, §4.5, §5.1, §5.2)

**Interfaces:**

- Consumes:
  - `PinnedClient::send`, `Credentials`, `RequestError` — `src-tauri/src/host_client.rs`; `DeviceInfo` — `markiro_proto`; `device_config::save`, `device_config::path` — `src-tauri/src/device_config.rs`;
  - `createSyncScheduler(run)` — `src/local/reference-sync.ts`; `DeviceError` — `src/host/device.ts`; `nextShellView` — `src/app/shell.ts`.
- Produces:
  - `DeviceState::refresh(&self) -> Result<DeviceStatus, DeviceError>`; команда `device_refresh` (без аргументов, ответ — `DeviceStatus`, отказ — код `DeviceError`);
  - `DeviceApi.refresh: () => Promise<DeviceStatus>`;
  - `ShellAction` `{ type: "device_refreshed"; status: DeviceStatus }`; `deviceRejection(error: unknown): RejectionReason | null`;
  - `HostLinkOptions.refresh: () => Promise<DeviceStatus>`.

- [ ] **Step 1: Тесты (падающие)**

В `test/app.test.tsx` поддельное устройство получает `refresh` (по умолчанию он отдаёт то, что держит оболочка), а новые тесты стоят в конце файла, в своём блоке `describe`.

1. В `apps/standalone/src-tauri/tests/line.rs`, фрагмент

<!-- prettier-ignore -->
```rust
//! Line selection and the webview's route list against a real `markiro-host`
//! on 127.0.0.1 (stage 1 spec §5.1–5.2).

use std::path::Path;

```

заменить на

<!-- prettier-ignore -->
```rust
//! Line selection, the station adopting the line the office assigns, and the
//! webview's route list against a real `markiro-host` on 127.0.0.1 (stage 1
//! spec §5.1–5.2).

use std::path::Path;

```

2. В `apps/standalone/src-tauri/tests/line.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    format!("https://{}", host.addr)
}

/// A station paired over loopback with the wizard done (one line).
async fn paired_station(host: &RunningHost, dir: &Path) -> DeviceState {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
```

заменить на

<!-- prettier-ignore -->
```rust
    format!("https://{}", host.addr)
}

/// A station paired over loopback with the wizard done (one line), and the
/// office session of the administrator the wizard created on it.
async fn office_station(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
```

3. В `apps/standalone/src-tauri/tests/line.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    station
}

/// The ids of the host's lines, read from the change feed as the webview does.
```

заменить на

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (station, token)
}

/// A station paired over loopback with the wizard done (one line).
async fn paired_station(host: &RunningHost, dir: &Path) -> DeviceState {
    office_station(host, dir).await.0
}

/// Another line, added in the office.
async fn office_line(station: &DeviceState, token: &str, name: &str) -> String {
    let created = station
        .request(
            "POST",
            "/v1/office/lines",
            Some(&json!({ "name": name })),
            Some(token),
        )
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    created.body.unwrap()["id"].as_str().unwrap().to_owned()
}

/// The office sets this station's line, or clears it with `None`.
async fn assign_line(station: &DeviceState, token: &str, line_id: Option<&str>) {
    let device_id = station.status().unwrap().unwrap().device_id;
    let updated = station
        .request(
            "PUT",
            &format!("/v1/office/devices/{device_id}"),
            Some(&json!({ "lineId": line_id })),
            Some(token),
        )
        .await
        .unwrap();
    assert_eq!(updated.status, 200, "{:?}", updated.body);
}

/// The line the host has for this station (`GET /v1/device`).
async fn host_line(station: &DeviceState) -> Value {
    let device = station
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    device.body.unwrap()["lineId"].clone()
}

/// The line `device.json` holds, read as the app does at start.
fn saved_line(dir: &Path) -> Option<String> {
    DeviceState::load(dir.to_path_buf())
        .status()
        .unwrap()
        .unwrap()
        .line_id
}

/// The ids of the host's lines, read from the change feed as the webview does.
```

4. В `apps/standalone/src-tauri/tests/line.rs`, фрагмент

<!-- prettier-ignore -->
```rust
}

#[tokio::test]
async fn line_selection_needs_a_pairing() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
```

заменить на

<!-- prettier-ignore -->
```rust
}

#[tokio::test]
async fn a_station_adopts_the_line_the_office_assigns_and_keeps_it_across_restarts() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let first = line_ids(&station).await.remove(0);
    station.select_line(&first).await.unwrap();
    let second = office_line(&station, &token, "Линия 2").await;

    assign_line(&station, &token, Some(&second)).await;
    let status = station.refresh().await.unwrap();
    assert_eq!(status.line_id.as_deref(), Some(second.as_str()));
    assert_eq!(station.status(), Ok(Some(status)));
    assert_eq!(saved_line(station_dir.path()), Some(second));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_refresh_that_finds_the_same_line_writes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    // A rename in the office is no line change for the station.
    let device_id = chosen.device_id.clone();
    let renamed = station
        .request(
            "PUT",
            &format!("/v1/office/devices/{device_id}"),
            Some(&json!({ "name": "Станция упаковки" })),
            Some(&token),
        )
        .await
        .unwrap();
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);
    let config = device_config::path(station_dir.path());
    let before = std::fs::read(&config).unwrap();
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&config).unwrap());

    assert_eq!(station.refresh().await, Ok(chosen));
    assert_eq!(std::fs::read(&config).unwrap(), before);
    // `device_config::save` writes a new file and renames it into place, so
    // an untouched inode shows that nothing was written at all.
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&config).unwrap()),
        inode
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_line_the_office_clears_is_cleared_on_the_station() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    station.select_line(&line).await.unwrap();

    assign_line(&station, &token, None).await;
    assert_eq!(station.refresh().await.unwrap().line_id, None);
    assert_eq!(station.status().unwrap().unwrap().line_id, None);
    assert_eq!(saved_line(station_dir.path()), None);
    host.stop().await.unwrap();
}

/// Offline first: with the host away the station keeps working on its line.
#[tokio::test]
async fn an_unreachable_host_leaves_the_line_alone() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let first = line_ids(&station).await.remove(0);
    station.select_line(&first).await.unwrap();
    let second = office_line(&station, &token, "Линия 2").await;
    assign_line(&station, &token, Some(&second)).await;
    host.stop().await.unwrap();

    assert_eq!(
        station.refresh().await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
    assert_eq!(
        station.status().unwrap().unwrap().line_id.as_deref(),
        Some(first.as_str())
    );
    assert_eq!(saved_line(station_dir.path()), Some(first));
}

/// A `device.json` whose key the host never issued (as after a revocation).
#[tokio::test]
async fn a_refresh_with_a_key_the_host_does_not_know_is_rejected() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let config = DeviceConfig {
        host_address: address(&host),
        fingerprint: host.fingerprint.clone(),
        host_id: host.host_id.clone(),
        device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
        kind: DeviceKind::Station,
        line_id: Some(UNKNOWN_LINE.into()),
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
    device_config::save(station_dir.path(), &config).unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());

    assert_eq!(station.refresh().await, Err(DeviceError::KeyRejected));
    assert_eq!(
        station.status().unwrap().unwrap().line_id.as_deref(),
        Some(UNKNOWN_LINE)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_refresh_needs_a_pairing() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(station.refresh().await, Err(DeviceError::NotPaired));
}

/// A refresh holds the pairing lock like `select_line`: a forget that starts
/// while the host is still answering waits for it, so the answer cannot
/// write `device.json` back after the forget removed it.
#[tokio::test]
async fn a_refresh_does_not_bring_back_a_forgotten_pairing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    // The station has no line yet; the office's line makes the refresh write.
    assign_line(&station, &token, Some(&line)).await;

    let (refreshed, forgotten) = tokio::join!(station.refresh(), station.forget());
    assert_eq!(refreshed.unwrap().line_id.as_deref(), Some(line.as_str()));
    forgotten.unwrap();
    assert_eq!(station.status(), Ok(None));
    assert!(!device_config::path(station_dir.path()).exists());
    host.stop().await.unwrap();
}

/// A refresh and a line choice at the same moment end on the line the host
/// took last, on the host, in memory and in `device.json` alike.
#[tokio::test]
async fn a_refresh_and_a_line_choice_never_undo_each_other() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let first = line_ids(&station).await.remove(0);
    let second = office_line(&station, &token, "Линия 2").await;
    for round in 0..6 {
        let (assigned, chosen) = if round % 2 == 0 {
            (&second, &first)
        } else {
            (&first, &second)
        };
        assign_line(&station, &token, Some(assigned)).await;
        let (refreshed, selected) = tokio::join!(station.refresh(), station.select_line(chosen));
        refreshed.unwrap();
        assert_eq!(selected.unwrap().line_id.as_deref(), Some(chosen.as_str()));
        assert_eq!(host_line(&station).await, json!(chosen), "round {round}");
        assert_eq!(
            station.status().unwrap().unwrap().line_id.as_deref(),
            Some(chosen.as_str()),
            "round {round}"
        );
        assert_eq!(
            saved_line(station_dir.path()).as_deref(),
            Some(chosen.as_str()),
            "round {round}"
        );
    }
    host.stop().await.unwrap();
}

#[tokio::test]
async fn line_selection_needs_a_pairing() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
```

5. В `apps/standalone/src-tauri/tests/ipc.rs`, фрагмент

<!-- prettier-ignore -->
```rust
/// clear: `device_forget` still removes `device.json` on its own. This test
/// needs no host, so it runs in the sandbox — so does the test above, which
/// also uses an unreadable config and no host, but opens a working local
/// database with copies to clear instead of leaving it unopened. Plan 1d3
/// revisits this decision before PIN and badge hashes live in the local
/// database.
#[test]
```

заменить на

<!-- prettier-ignore -->
```rust
/// clear: `device_forget` still removes `device.json` on its own. This test
/// needs no host, so it runs in the sandbox — so does the test above, which
/// also uses an unreadable config and no host, but opens a working local
/// database with copies to clear instead of leaving it unopened. Plan 1d4
/// revisits this decision before PIN and badge hashes live in the local
/// database.
#[test]
```

6. В `apps/standalone/src-tauri/tests/ipc.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    host.stop();
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
fn the_connection_status_has_the_webview_shape() {
```

заменить на

<!-- prettier-ignore -->
```rust
    host.stop();
}

/// `device_refresh` takes no arguments (`src/host/device.ts`) and answers the
/// pairing's `DeviceStatus` with the line the office assigned.
#[test]
fn a_station_takes_the_office_line_through_the_ipc_shapes() {
    let host = Host::start();
    let app_dir = tempfile::tempdir().unwrap();
    let pairing = DeviceState::load(app_dir.path().to_path_buf());
    let paired = host
        .runtime
        .block_on(pairing.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = host
        .runtime
        .block_on(pairing.request("POST", "/v1/bootstrap", Some(&bootstrap), None))
        .unwrap();
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let feed = host
        .runtime
        .block_on(pairing.request("GET", "/v1/changes?since=0", None, None))
        .unwrap();
    let line = feed.body.unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "lines")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let assigned = host
        .runtime
        .block_on(pairing.request(
            "PUT",
            &format!("/v1/office/devices/{}", paired.device_id),
            Some(&json!({ "lineId": line })),
            Some(&token),
        ))
        .unwrap();
    assert_eq!(assigned.status, 200);
    drop(pairing);
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    let refreshed = invoke(&webview, "device_refresh", json!({})).unwrap();
    assert_eq!(refreshed["lineId"], line);
    assert_eq!(refreshed["deviceId"], paired.device_id);
    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(refreshed));

    drop(webview);
    host.stop();
}

/// Without a pairing there is nothing to read again; no host needs to answer.
#[test]
fn an_unpaired_device_has_nothing_to_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(&webview, "device_refresh", json!({})),
        Err(json!("not_paired"))
    );
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
fn the_connection_status_has_the_webview_shape() {
```

7. В `apps/standalone/test/device.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(call).toHaveBeenCalledWith("device_select_line", { lineId });
  });

  it.each(DEVICE_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    expect((await failure(createTauriDeviceApi(call).pairLocally("x"))).code).toBe(code);
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(call).toHaveBeenCalledWith("device_select_line", { lineId });
  });

  it("reads the device again from the host, with the line the office assigned", async () => {
    const lineId = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, lineId });
    const { refresh } = createTauriDeviceApi(call);
    // Unbound on purpose: `useHostLink` receives the function on its own.
    await expect(refresh()).resolves.toEqual({ ...DEVICE_STATUS, lineId });
    expect(call).toHaveBeenCalledWith("device_refresh", {});
  });

  it("keeps the shell's reason when the host refuses the key on a refresh", async () => {
    const call = vi.fn().mockRejectedValue("key_rejected");
    expect((await failure(createTauriDeviceApi(call).refresh())).code).toBe("key_rejected");
  });

  it.each(DEVICE_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    expect((await failure(createTauriDeviceApi(call).pairLocally("x"))).code).toBe(code);
```

8. В `apps/standalone/test/shell.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  initialShellState,
  nextShellView,
  shellActionFor,
```

заменить на

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  deviceRejection,
  initialShellState,
  nextShellView,
  shellActionFor,
```

9. В `apps/standalone/test/shell.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import type { HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, NEW_STATION, observation, SESSION } from "./support/fixtures.js";

```

заменить на

<!-- prettier-ignore -->
```ts
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import type { HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, NEW_STATION, observation, SESSION } from "./support/fixtures.js";

```

10. В `apps/standalone/test/shell.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(nextShellView(chosen, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("retries a failed pairing", () => {
    const failed = unpaired({ pairing: { kind: "failed", code: "unreachable" } });
    expect(shellReducer(failed, { type: "pairing_retried" }).pairing).toEqual({ kind: "idle" });
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(nextShellView(chosen, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("follows a line the office assigned or cleared, on a refresh of this device", () => {
    const station = paired();
    const cleared = shellReducer(station, { type: "device_refreshed", status: NEW_STATION });
    expect(cleared.device).toEqual({ kind: "ready", status: NEW_STATION });
    expect(nextShellView(cleared, ADDRESS)).toEqual({ kind: "line_select" });
    const assigned = shellReducer(cleared, { type: "device_refreshed", status: DEVICE_STATUS });
    expect(nextShellView(assigned, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("keeps the state for a refresh that changes nothing or belongs to another pairing", () => {
    const station = paired();
    expect(shellReducer(station, { type: "device_refreshed", status: DEVICE_STATUS })).toBe(
      station,
    );
    const otherDevice = { ...NEW_STATION, deviceId: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d" };
    expect(shellReducer(station, { type: "device_refreshed", status: otherDevice })).toBe(station);
    const otherHost = { ...NEW_STATION, hostId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };
    expect(shellReducer(station, { type: "device_refreshed", status: otherHost })).toBe(station);
    // A late answer after the pairing was forgotten does not bring it back.
    const forgotten = shellReducer(station, { type: "forgotten" });
    expect(shellReducer(forgotten, { type: "device_refreshed", status: NEW_STATION })).toBe(
      forgotten,
    );
  });

  it("retries a failed pairing", () => {
    const failed = unpaired({ pairing: { kind: "failed", code: "unreachable" } });
    expect(shellReducer(failed, { type: "pairing_retried" }).pairing).toEqual({ kind: "idle" });
```

11. В `apps/standalone/test/shell.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});

describe("shellActionFor", () => {
  function unauthorized(credential: string): HostError {
    return new HostError({
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

describe("deviceRejection", () => {
  it("needs a new pairing for a refused key or a changed certificate, and nothing else", () => {
    expect(deviceRejection(new DeviceError("key_rejected", "revoked"))).toBe("key_rejected");
    expect(deviceRejection(new DeviceError("certificate_mismatch", "reinstalled"))).toBe(
      "host_changed",
    );
    expect(deviceRejection(new DeviceError("unreachable", "down"))).toBeNull();
    expect(deviceRejection(new DeviceError("storage", "disk"))).toBeNull();
    expect(
      deviceRejection(new HostError({ kind: "transport", code: "unreachable", message: "" })),
    ).toBeNull();
    expect(deviceRejection(new Error("boom"))).toBeNull();
  });
});

describe("shellActionFor", () => {
  function unauthorized(credential: string): HostError {
    return new HostError({
```

12. В `apps/standalone/test/app.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    forget: vi.fn<DeviceApi["forget"]>(async () => {
      paired = null;
      broken = null;
    }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    forget: vi.fn<DeviceApi["forget"]>(async () => {
      paired = null;
      broken = null;
    }),
    // The host's record of the device: by default what the shell keeps.
    refresh: vi.fn<DeviceApi["refresh"]>(async () => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      return paired;
    }),
  };
}
```

13. В `apps/standalone/test/app.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Не приняты записи справочников: 1")).toBeTruthy();
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Не приняты записи справочников: 1")).toBeTruthy();
  });
});

describe("the line the office assigns", () => {
  /** Lets every pending effect and timer task settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("goes back to choosing a line when the office clears it, and on when the office sets one", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));

    device.refresh.mockResolvedValueOnce(NEW_STATION);
    await link.revision(43);
    expect(await screen.findByText("Выбор линии")).toBeTruthy();

    device.refresh.mockResolvedValueOnce(DEVICE_STATUS);
    await link.revision(44);
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.selectLine).not.toHaveBeenCalled();
  });

  it("reads the device once after the first sync and once per revision, one read at a time", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(1);

    let answer: (status: DeviceStatus) => void = () => undefined;
    device.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await link.revision(43);
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    // Two more revisions while that read is on its way ask for one more read.
    await link.revision(44);
    await link.revision(45);
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      answer(DEVICE_STATUS);
    });
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(3));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "key_rejected",
      "Хост не узнаёт ключ этого устройства: устройство могли отключить в офисе или восстановить базу хоста из копии.",
    ],
    [
      "certificate_mismatch",
      "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
    ],
  ] as const)(
    "sends a station whose refresh meets %s to pairing again, and stops the link",
    async (code, reason) => {
      const link = fakeConnection();
      const device = fakeDevice(DEVICE_STATUS);
      device.refresh.mockRejectedValue(new DeviceError(code, "refused"));
      renderApp({
        probe: probeAnswering(true),
        device,
        host: fakeHost(),
        connection: link.connection,
      });
      expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
      expect(screen.getByText(reason)).toBeTruthy();
      await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    },
  );

  it("keeps the station on its line when a refresh cannot reach the host", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.refresh.mockRejectedValue(new DeviceError("unreachable", "host down"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await link.revision(43);
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    await settle();
    expect(screen.getByText("Цех")).toBeTruthy();
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    expect(link.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/shell.test.ts test/app.test.tsx`
Expected: FAIL — 10 тестов из 124:

- `device.test.ts`, 2 из 29: `refresh is not a function`;
- `shell.test.ts`, 3 из 38: `deviceRejection is not a function`, `Cannot read properties of undefined (reading 'device')` и `expected undefined to be { …(8) }` (редьюсер не знает `device_refreshed`);
- `app.test.tsx`, 5 из 57: `expected "vi.fn()" to be called 1 times, but got 0 times` (никто не зовёт `refresh`) и нет экрана «Хост не принимает это устройство».

Run: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`, затем `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --offline --no-run`
Expected: FAIL — ``error[E0599]: no method named `refresh` found for struct `DeviceState` in the current scope``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline an_unpaired_device_has_nothing_to_refresh` (в песочнице)
Expected: FAIL — `left: Err(String("Command device_refresh not found"))`, `right: Err(String("not_paired"))`.

- [ ] **Step 3: Rust — `refresh`, `keep_line` и команда `device_refresh`**

1. В `apps/standalone/src-tauri/src/device.rs`, фрагмент

<!-- prettier-ignore -->
```rust
//! The paired device (spec §5.2): `device.json`, local pairing with the host
//! on this computer, pairing by code, line selection, and authenticated
//! requests. The device key never leaves this module: the webview sees
//! `DeviceStatus`, never the key.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
```

заменить на

<!-- prettier-ignore -->
```rust
//! The paired device (spec §5.2): `device.json`, local pairing with the host
//! on this computer, pairing by code, line selection, the line the office
//! assigns, and authenticated requests. The device key never leaves this
//! module: the webview sees `DeviceStatus`, never the key.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
```

2. В `apps/standalone/src-tauri/src/device.rs`, фрагмент

<!-- prettier-ignore -->
```rust
/// A station's line (`PUT /v1/device/line`): only [`DeviceState::select_line`]
/// reaches it, so `device.json` always holds the line the host confirmed.
const LINE_ROUTE: &str = "/v1/device/line";

/// What the webview may know about the pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
```

заменить на

<!-- prettier-ignore -->
```rust
/// A station's line (`PUT /v1/device/line`): only [`DeviceState::select_line`]
/// reaches it, so `device.json` always holds the line the host confirmed.
const LINE_ROUTE: &str = "/v1/device/line";

/// This device's own record (`GET /v1/device`), which [`DeviceState::refresh`]
/// reads for the line the office assigned.
const DEVICE_ROUTE: &str = "/v1/device";

/// What the webview may know about the pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
```

3. В `apps/standalone/src-tauri/src/device.rs`, фрагмент

<!-- prettier-ignore -->
```rust
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        let info: DeviceInfo = response
            .body
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        let config = DeviceConfig {
            line_id: info.line_id,
            ..device.config.clone()
```

заменить на

<!-- prettier-ignore -->
```rust
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_line(&device, response.body)
    }

    /// Read this device's record again (`GET /v1/device`) and keep the line
    /// the host has for it, so a line an administrator set or cleared in the
    /// office reaches the station (plan 1d3). `device.json` is written only
    /// when the line differs. Serialised with pairing, forgetting and
    /// [`Self::select_line`] through the same lock, so an answer never
    /// writes over a pairing or a line choice that changed meanwhile. A host
    /// that cannot be reached changes nothing: the station keeps working on
    /// its line (offline first).
    pub async fn refresh(&self) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        let device = self.paired()?;
        let response = device
            .client
            .send(
                "GET",
                DEVICE_ROUTE,
                None,
                Credentials {
                    device_key: Some(&device.key),
                    office_token: None,
                },
            )
            .await
            .map_err(DeviceError::Request)?;
        match response.status {
            200 => {}
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_line(&device, response.body)
    }

    /// Make the line in the host's answer (`DeviceInfo`) this device's line:
    /// `device.json` first, then the pairing in memory, and neither when the
    /// line is already the one kept. Called with the pairing lock held.
    fn keep_line(
        &self,
        device: &PairedDevice,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
        let info: DeviceInfo = body
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        if info.line_id == device.config.line_id {
            return Ok(device.status());
        }
        let config = DeviceConfig {
            line_id: info.line_id,
            ..device.config.clone()
```

4. В `apps/standalone/src-tauri/src/device.rs`, фрагмент

<!-- prettier-ignore -->
```rust
/// Routes the webview may reach through `host_request`. Pairing routes are
/// excluded: their answers carry a new device key, which must never cross
/// IPC. The line goes through [`DeviceState::select_line`], which also keeps
/// it in `device.json`; the change stream belongs to the connection task.
/// This string-level exclusion of `LINE_ROUTE` only holds because
/// `host_client::validate_path` separately refuses a `.` path segment: it
/// stops a spelling such as `/v1/device/./line`, which a URL parser would
```

заменить на

<!-- prettier-ignore -->
```rust
/// Routes the webview may reach through `host_request`. Pairing routes are
/// excluded: their answers carry a new device key, which must never cross
/// IPC. The line goes through [`DeviceState::select_line`], which also keeps
/// it in `device.json` (as [`DeviceState::refresh`] keeps the line the
/// office assigns); the change stream belongs to the connection task.
/// This string-level exclusion of `LINE_ROUTE` only holds because
/// `host_client::validate_path` separately refuses a `.` path segment: it
/// stops a spelling such as `/v1/device/./line`, which a URL parser would
```

5. В `apps/standalone/src-tauri/src/lib.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        .map_err(|error| error.code().to_owned())
}

/// Forget the pairing: the local copies go first, so when clearing them
/// fails the command answers `storage` and `device.json` stays for another
/// try. Without a local database (it did not open) there is nothing this
```

заменить на

<!-- prettier-ignore -->
```rust
        .map_err(|error| error.code().to_owned())
}

/// Read this device's record from the host again and keep the line the
/// office assigned; the webview calls it after the first sync and after
/// every revision event.
#[tauri::command]
async fn device_refresh(state: tauri::State<'_, DeviceState>) -> Result<DeviceStatus, String> {
    state
        .refresh()
        .await
        .map_err(|error| error.code().to_owned())
}

/// Forget the pairing: the local copies go first, so when clearing them
/// fails the command answers `storage` and `device.json` stays for another
/// try. Without a local database (it did not open) there is nothing this
```

6. В `apps/standalone/src-tauri/src/lib.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        host_claim,
        host_request,
        device_select_line,
        device_forget,
        local_query,
        local_transaction,
```

заменить на

<!-- prettier-ignore -->
```rust
        host_claim,
        host_request,
        device_select_line,
        device_refresh,
        device_forget,
        local_query,
        local_transaction,
```

- [ ] **Step 4: Вебвью — привязка, действие, хук и `App`**

1. В `apps/standalone/src/host/device.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  selectLine(lineId: string): Promise<DeviceStatus>;
  /** Forget the pairing kept on this computer. */
  forget(): Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
```

заменить на

<!-- prettier-ignore -->
```ts
  selectLine(lineId: string): Promise<DeviceStatus>;
  /** Forget the pairing kept on this computer. */
  forget(): Promise<void>;
  /**
   * Read this device's record from the host again (`device_refresh`); the
   * shell keeps the line the office assigned in `device.json`. A
   * function-typed property, unlike the methods above, because `useHostLink`
   * takes it unbound (`@typescript-eslint/unbound-method`).
   */
  refresh: () => Promise<DeviceStatus>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
```

2. В `apps/standalone/src/host/device.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    async forget() {
      await run("device_forget", {});
    },
  };
}

```

заменить на

<!-- prettier-ignore -->
```ts
    async forget() {
      await run("device_forget", {});
    },
    refresh: async () => parseStatus(await run("device_refresh", {})),
  };
}

```

3. В `apps/standalone/src/app/shell.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { HostError } from "../host/client.js";
import type { DeviceErrorCode } from "../host/device.js";
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, HostStatus, OfficeSession, OfficeUser } from "../host/protocol.js";
import type { SyncResult } from "../local/reference-sync.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { HostError } from "../host/client.js";
import { DeviceError, type DeviceErrorCode } from "../host/device.js";
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, HostStatus, OfficeSession, OfficeUser } from "../host/protocol.js";
import type { SyncResult } from "../local/reference-sync.js";
```

4. В `apps/standalone/src/app/shell.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  | { type: "sync_started" }
  | { type: "sync_finished"; result: SyncResult }
  | { type: "sync_failed"; failure: SyncFailure; quarantined: number | null }
  | { type: "line_selected"; status: DeviceStatus };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
```

заменить на

<!-- prettier-ignore -->
```ts
  | { type: "sync_started" }
  | { type: "sync_finished"; result: SyncResult }
  | { type: "sync_failed"; failure: SyncFailure; quarantined: number | null }
  | { type: "line_selected"; status: DeviceStatus }
  | { type: "device_refreshed"; status: DeviceStatus };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
```

5. В `apps/standalone/src/app/shell.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      };
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status } };
  }
}

/**
```

заменить на

<!-- prettier-ignore -->
```ts
      };
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status } };
    case "device_refreshed": {
      // The line the office assigned (plan 1d3). Only the pairing the answer
      // belongs to takes it, so a late answer cannot bring back a pairing
      // that ended or changed; an answer with the same line changes nothing.
      // A cleared line sends the station back to choosing one.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const current = state.device.status;
      if (
        current.deviceId !== action.status.deviceId ||
        current.hostId !== action.status.hostId ||
        current.lineId === action.status.lineId
      ) {
        return state;
      }
      return { ...state, device: { kind: "ready", status: action.status } };
    }
  }
}

/**
 * Why a failed device command needs a new pairing: the host refused this
 * device's key, or presented another certificate than the one pinned at
 * pairing. `null` for anything else, which the caller explains or ignores.
 */
export function deviceRejection(error: unknown): RejectionReason | null {
  if (!(error instanceof DeviceError)) return null;
  if (error.code === "key_rejected") return "key_rejected";
  if (error.code === "certificate_mismatch") return "host_changed";
  return null;
}

/**
```

6. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts

import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import type { ChangesResponse } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import {
  createSyncScheduler,
  readQuarantineCount,
  syncReferences,
} from "../local/reference-sync.js";
import { shellActionFor, type ShellAction, type SyncFailure } from "./shell.js";

/** The waits before the first retries of a failed sync, in milliseconds. */
const RETRY_MS = [2000, 4000, 8000, 16000, 32000] as const;
```

заменить на

<!-- prettier-ignore -->
```ts

import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import type { ChangesResponse, DeviceStatus } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import {
  createSyncScheduler,
  readQuarantineCount,
  syncReferences,
} from "../local/reference-sync.js";
import { deviceRejection, shellActionFor, type ShellAction, type SyncFailure } from "./shell.js";

/** The waits before the first retries of a failed sync, in milliseconds. */
const RETRY_MS = [2000, 4000, 8000, 16000, 32000] as const;
```

7. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  local: LocalExecutor;
  /** `HostApi.getChanges`. */
  changes: (since: number) => Promise<ChangesResponse>;
  dispatch: (action: ShellAction) => void;
}

```

заменить на

<!-- prettier-ignore -->
```ts
  local: LocalExecutor;
  /** `HostApi.getChanges`. */
  changes: (since: number) => Promise<ChangesResponse>;
  /** `DeviceApi.refresh`: this device's record, read again with the office's line. */
  refresh: () => Promise<DeviceStatus>;
  dispatch: (action: ShellAction) => void;
}

```

8. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
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
```

заменить на

<!-- prettier-ignore -->
```ts
 * reconnect carries the host's current revision, so catching up needs
 * nothing more. A failed run — not another host, not a rejected device — is
 * retried while the link is online, after `nextSyncRetryMs`; a lost link
 * drops the pending retry, and the link coming back syncs at once. At the
 * same moments it reads this device's record again (`refresh`): a line the
 * office assigns takes a revision but no feed item, so only the record
 * carries it. Returns a function that asks for a sync now.
 */
export function useHostLink({
  hostId,
  connection,
  local,
  changes,
  refresh,
  dispatch,
}: HostLinkOptions): () => void {
  const syncNow = useRef<() => void>(() => undefined);
```

9. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          scheduler.stop();
        }
        dispatch({ type: "sync_finished", result });
      } catch (error) {
```

заменить на

<!-- prettier-ignore -->
```ts
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          scheduler.stop();
          refresher.stop();
        }
        dispatch({ type: "sync_finished", result });
      } catch (error) {
```

10. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          scheduler.stop();
          dispatch(action);
        }
        // Worth reading only when nothing else is about to reset the sync
```

заменить на

<!-- prettier-ignore -->
```ts
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          scheduler.stop();
          refresher.stop();
          dispatch(action);
        }
        // Worth reading only when nothing else is about to reset the sync
```

11. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        }
      } finally {
        running = false;
      }
    });
    syncNow.current = scheduler.trigger;
```

заменить на

<!-- prettier-ignore -->
```ts
        }
      } finally {
        running = false;
      }
    });
    // One read of this device at a time; events during a read ask for
    // exactly one more, as for the sync.
    const refresher = createSyncScheduler(async () => {
      if (!active) return;
      try {
        const status = await refresh();
        if (active) dispatch({ type: "device_refreshed", status });
      } catch (error) {
        if (!active) return;
        // A refused key or a changed certificate needs a new pairing, as on
        // every other host path. Anything else — the host away, a failed
        // write of `device.json` — keeps the line this station already has
        // (offline first), and the next event tries again.
        const reason = deviceRejection(error);
        if (reason !== null) {
          scheduler.stop();
          refresher.stop();
          dispatch({ type: "device_rejected", reason });
        }
      }
    });
    syncNow.current = scheduler.trigger;
```

12. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          scheduler.trigger();
        },
      })
      .then(
```

заменить на

<!-- prettier-ignore -->
```ts
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          scheduler.trigger();
          refresher.trigger();
        },
      })
      .then(
```

13. В `apps/standalone/src/app/host-link.ts`, фрагмент

<!-- prettier-ignore -->
```ts
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

заменить на

<!-- prettier-ignore -->
```ts
          // not replayed, so a sync started earlier could miss a commit that
          // landed between its fetch and the listener.
          scheduler.trigger();
          refresher.trigger();
        },
        () => {
          // Without events the copies still sync once here and on request.
          if (!active) return;
          scheduler.trigger();
          refresher.trigger();
        },
      );
    return () => {
      active = false;
      syncNow.current = () => undefined;
      scheduler.stop();
      refresher.stop();
      cancelRetry();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, refresh, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
```

14. В `apps/standalone/src/app/App.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
import { initialShellState, nextShellView, shellActionFor, shellReducer } from "./shell.js";

export interface AppProps {
  probe?: HostProbe;
```

заменить на

<!-- prettier-ignore -->
```tsx
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
import {
  deviceRejection,
  initialShellState,
  nextShellView,
  shellActionFor,
  shellReducer,
} from "./shell.js";

export interface AppProps {
  probe?: HostProbe;
```

15. В `apps/standalone/src/app/App.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    connection: connectionApi,
    local: localDb,
    changes: hostApi.getChanges,
    dispatch,
  });

```

заменить на

<!-- prettier-ignore -->
```tsx
    connection: connectionApi,
    local: localDb,
    changes: hostApi.getChanges,
    refresh: deviceApi.refresh,
    dispatch,
  });

```

16. В `apps/standalone/src/app/App.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      try {
        dispatch({ type: "line_selected", status: await deviceApi.selectLine(lineId) });
      } catch (error) {
        if (error instanceof DeviceError && error.code === "key_rejected") {
          dispatch({ type: "device_rejected", reason: "key_rejected" });
          return;
        }
        if (error instanceof DeviceError && error.code === "certificate_mismatch") {
          dispatch({ type: "device_rejected", reason: "host_changed" });
          return;
        }
        throw error;
```

заменить на

<!-- prettier-ignore -->
```tsx
      try {
        dispatch({ type: "line_selected", status: await deviceApi.selectLine(lineId) });
      } catch (error) {
        const reason = deviceRejection(error);
        if (reason !== null) {
          dispatch({ type: "device_rejected", reason });
          return;
        }
        throw error;
```

- [ ] **Step 5: Запустить тесты — они проходят**

Run: та же команда Vitest, что в шаге 2; затем она же с `--reporter=verbose`.
Expected: PASS — 29 тестов в `device.test.ts`, 38 в `shell.test.ts`, 57 в `app.test.tsx` (124); stderr пуст.

Run: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`, затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --offline`
Expected: PASS — 13 тестов в `line`, 11 в `ipc`.

- [ ] **Step 6: Документы**

Разделы «Local database» и «Reference sync» заодно исправляют ссылку «plan 1d3» на план 1d4: очистка без открытой базы и операторы с бейджами перенесены туда брифом.

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
records exist, not extend this list silently. If clearing fails, the
command fails with `storage` and the pairing stays for another try; without
a local database (it did not open) there is nothing this app can clear, and
forgetting goes on; plan 1d3 revisits this before PIN and badge hashes land.

## Writes

```

заменить на

<!-- prettier-ignore -->
```text
records exist, not extend this list silently. If clearing fails, the
command fails with `storage` and the pairing stays for another try; without
a local database (it did not open) there is nothing this app can clear, and
forgetting goes on; plan 1d4 revisits this before PIN and badge hashes land.

## Writes

```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
For E kept entities a page batch holds at most 3E + 6 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the quarantine upsert and lift, and the sync state. That
is 15 today and 21 with plan 1d3's operators and badges, within the
shell's 32 (E = 8 at most); a test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines;v2"`): raise the version whenever a record
```

заменить на

<!-- prettier-ignore -->
```text
For E kept entities a page batch holds at most 3E + 6 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the quarantine upsert and lift, and the sync state. That
is 15 today and 21 with plan 1d4's operators and badges, within the
shell's 32 (E = 8 at most); a test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines;v2"`): raise the version whenever a record
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
`/v1/device/line`, `/v1/bootstrap`, `/v1/changes` (not `/v1/changes/stream`)
and `/v1/office/…`. The line goes through `device_select_line`, which also
keeps the host's answer in `device.json`, so the station opens on its line
with the host away; the change stream belongs to the connection task.
Pairing routes return a new device key, so they stay behind their own
commands (`host_local_pair`, `host_claim`) and the key never reaches the
webview. `%` is refused because an encoded `..` would slip past the route
```

заменить на

<!-- prettier-ignore -->
```text
`/v1/device/line`, `/v1/bootstrap`, `/v1/changes` (not `/v1/changes/stream`)
and `/v1/office/…`. The line goes through `device_select_line`, which also
keeps the host's answer in `device.json`, so the station opens on its line
with the host away; `device_refresh` reads `GET /v1/device` again and keeps
a line the office changed the same way; the change stream belongs to the
connection task.
Pairing routes return a new device key, so they stay behind their own
commands (`host_local_pair`, `host_claim`) and the key never reaches the
webview. `%` is refused because an encoded `..` would slip past the route
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  even if that line has been archived since, so a full-form save can still
  rename the station). Devices have no `rev` and are not in the feed, so the
  last office write wins. A change of a device's line takes one host
  revision without a feed item, so open streams wake and the station can read
  `GET /v1/device` again; a rename, a repeat of the same line and a
  revocation take none. The station's adoption of an office-assigned line is
  plan 1d3, and how that meets a running shift is plan 2a.
- The office session token lives only in webview memory. «Выйти в цех» ends
  the session at once: the app returns to the floor, drops the token and
  tells the host in the background. There is no hidden session (owner
```

заменить на

<!-- prettier-ignore -->
```text
  even if that line has been archived since, so a full-form save can still
  rename the station). Devices have no `rev` and are not in the feed, so the
  last office write wins. A change of a device's line takes one host
  revision without a feed item, so open streams wake and the station reads
  `GET /v1/device` again (`device_refresh`, see "App shell"); a rename, a
  repeat of the same line and a revocation take none. How a line change
  meets a running shift is plan 2a's decision; stage 1 has only the floor
  stub.
- The office session token lives only in webview memory. «Выйти в цех» ends
  the session at once: the app returns to the floor, drops the token and
  tells the host in the background. There is no hidden session (owner
```

5. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
shell's link and syncs reference data at start and after every revision
event; it stops when the pairing ends, is rejected or turns out to belong
to another host (`other_host`, which only a new pairing clears). A failed
run (neither another host nor a rejected device) is retried while the link
is online: after 2, 4, 8, 16 and 32 s, then every 60 s (`nextSyncRetryMs`).
A successful run starts the count again; any other run replaces the
```

заменить на

<!-- prettier-ignore -->
```text
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
shell's link and syncs reference data at start and after every revision
event; it stops when the pairing ends, is rejected or turns out to belong
to another host (`other_host`, which only a new pairing clears). At the
same moments it reads this device's record again (`device_refresh`): a line
the office sets or clears takes a revision but no feed item, so only the
record carries it. `DeviceState::refresh` reads `GET /v1/device` under the
pairing lock, like `select_line`, and writes `device.json` only when the
line changed. One read runs at a time and events during it ask for exactly
one more; its answer replaces the device status (`device_refreshed`) only
for the same pairing. A refused key or a changed certificate is a rejected
device, as on every host path; any other failure, the host away included,
keeps the station on its line. A failed
run (neither another host nor a rejected device) is retried while the link
is online: after 2, 4, 8, 16 and 32 s, then every 60 s (`nextSyncRetryMs`).
A successful run starts the count again; any other run replaces the
```

6. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
`stale_revision`. Pages read fresh data whenever they open (`staleTime` 0).

A paired station without a line chooses one (`LineSelect`) among the active
lines of the local copies, read only after a sync in this session brought them
up to date and again after every sync, so a previous pairing's lines never
show; the host's answer goes to `device.json` through `device_select_line`. A
refused device key or a changed certificate from that call is a rejected device
```

заменить на

<!-- prettier-ignore -->
```text
`stale_revision`. Pages read fresh data whenever they open (`staleTime` 0).

A paired station without a line chooses one (`LineSelect`) among the active
lines of the local copies (a line the office clears brings the station back
here, and a line the office sets moves it on), read only after a sync in this session brought them
up to date and again after every sync, so a previous pairing's lines never
show; the host's answer goes to `device.json` through `device_select_line`. A
refused device key or a changed certificate from that call is a rejected device
```

В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §4.4, §4.5, §5.1 и §5.2 (там же «план 1d3 пересмотрит» становится «план 1d4»):

7. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  ключа (`feed::restore`).
- Смена линии устройства в офисе (`PUT /v1/office/devices/{id}`) берёт одну ревизию
  хоста, но записи ленты не порождает (устройства в ленту не входят): потоки
  просыпаются, и станция может заново прочитать `GET /v1/device`. Переименование
  устройства и повтор той же линии ревизию не берут. Как станция принимает
  назначенную из офиса линию — план 1d3, как это сочетается с идущей сменой —
  план 2a.
- После коммита хост оповещает подписчиков потока о новой ревизии (канал
  `tokio::sync::watch`).

```

заменить на

<!-- prettier-ignore -->
```text
  ключа (`feed::restore`).
- Смена линии устройства в офисе (`PUT /v1/office/devices/{id}`) берёт одну ревизию
  хоста, но записи ленты не порождает (устройства в ленту не входят): потоки
  просыпаются, и станция заново читает `GET /v1/device` (§5.1). Переименование
  устройства и повтор той же линии ревизию не берут. Как это сочетается с идущей
  сменой — решение плана 2a.
- После коммита хост оповещает подписчиков потока о новой ревизии (канал
  `tokio::sync::watch`).

```

8. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
- устройства — `device-update.json` (`PUT` меняет только присланные `name` и
  `lineId`; `lineId: null` снимает линию; повтор текущей линии станции — «оставить»,
  даже если линию уже архивировали); смена линии берёт одну ревизию хоста без записи
  в ленте, и потоки просыпаются (принятие такой линии станцией — план 1d3,
  взаимодействие с идущей сменой — план 2a); ответ `PUT` и отзыва —
  `device-record.json`;
- коды подключения — `pairing-code.json` (ответ с `id` и `createdAt`),
```

заменить на

<!-- prettier-ignore -->
```text
- устройства — `device-update.json` (`PUT` меняет только присланные `name` и
  `lineId`; `lineId: null` снимает линию; повтор текущей линии станции — «оставить»,
  даже если линию уже архивировали); смена линии берёт одну ревизию хоста без записи
  в ленте, и потоки просыпаются (станция принимает такую линию — §5.1;
  взаимодействие с идущей сменой — план 2a); ответ `PUT` и отзыва —
  `device-record.json`;
- коды подключения — `pairing-code.json` (ответ с `id` и `createdAt`),
```

9. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
````text
       └─ руководитель вошёл в офис                     → office
```

Из экрана входа оператора есть кнопка «Офис»: форма логина и пароля руководителя.
Выход из офиса возвращает на экран входа оператора. Если хост недоступен, строка связи
в шапке офиса показывает «нет связи с хостом» и время последней связи, а каждый
````

заменить на

<!-- prettier-ignore -->
````text
       └─ руководитель вошёл в офис                     → office
```

Линию станции назначает и снимает и офис («Устройства», план 1d3): станция
перечитывает своё устройство (`GET /v1/device`, команда `device_refresh`) после
первой синхронизации и после каждого события ревизии, по одному чтению за раз, и
сохраняет изменившуюся линию в `device.json`. Снятая линия возвращает станцию на
выбор линии, назначенная — переводит на неё. Без связи с хостом станция остаётся
на своей линии; отказ ключа или смена сертификата — отказ устройства, как на
любом пути к хосту. Что смена линии значит для идущей смены — решение плана 2a;
на этапе 1 цех — заглушка.

Из экрана входа оператора есть кнопка «Офис»: форма логина и пароля руководителя.
Выход из офиса возвращает на экран входа оператора. Если хост недоступен, строка связи
в шапке офиса показывает «нет связи с хостом» и время последней связи, а каждый
````

10. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  наблюдаемый отпечаток), `device_status()`, `host_local_pair`, `host_claim(address, fingerprint, code, name)` (устройство подключается видом `station`),
  `host_request(method, path, body, officeToken?)`,
  `device_select_line(lineId)` (выбор линии; ответ хоста сохраняется в
  `device.json`), `device_forget()` (сначала очищает локальную базу — все таблицы,
  кроме журнала миграций; если очистка не удалась, подключение остаётся; если
  локальная база не открылась, для этого приложения очищать нечего — план 1d3
  пересмотрит это до того, как хеши PIN и бейджей лягут в локальную базу). Таймауты:
  соединение 2 с,
  запрос 10 с. `host_request` пропускает только маршруты `/v1/device[/…]` (кроме
```

заменить на

<!-- prettier-ignore -->
```text
  наблюдаемый отпечаток), `device_status()`, `host_local_pair`, `host_claim(address, fingerprint, code, name)` (устройство подключается видом `station`),
  `host_request(method, path, body, officeToken?)`,
  `device_select_line(lineId)` (выбор линии; ответ хоста сохраняется в
  `device.json`), `device_refresh()` (перечитывает `GET /v1/device` и сохраняет
  линию, назначенную или снятую в офисе, §5.1; без связи ничего не меняет),
  `device_forget()` (сначала очищает локальную базу — все таблицы,
  кроме журнала миграций; если очистка не удалась, подключение остаётся; если
  локальная база не открылась, для этого приложения очищать нечего — план 1d4
  пересмотрит это до того, как хеши PIN и бейджей лягут в локальную базу). Таймауты:
  соединение 2 с,
  запрос 10 с. `host_request` пропускает только маршруты `/v1/device[/…]` (кроме
```

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `… typecheck`, `… lint`, `… build`; вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`
Expected: всё зелёное; Vitest — 32 файла, 624 теста; cargo — 36 наборов, 345 тестов, без предупреждений компилятора.

```bash
git add apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/line.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src/host/device.ts apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/test/device.test.ts apps/standalone/test/shell.test.ts apps/standalone/test/app.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): станция подхватывает линию, назначенную в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build` — зелёные; Vitest — 32 файла, 624 теста (было 29 и 531); один прогон с `--reporter=verbose` — stderr пуст, предупреждений `act(...)` нет.
- [ ] `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'` (крейт оболочки встраивает `apps/standalone/dist`), затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — 36 наборов, 345 тестов (было 335), без предупреждений компилятора; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` — без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам — чисто; `git diff --check <начало плана>..HEAD` — чисто.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `apps/station`, `apps/standalone/host`, `apps/standalone/proto` и `tools/ci/affected.mjs` не менялись.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - окно `tauri dev`: страницы «Контрагенты», «Линии» и «Устройства» при ширине 1024–1280, выпадающий список линии в WebView2, тёмная и светлая темы, фокус при открытии и закрытии диалогов;
  - два ПК в настоящей сети:
    - линия, назначенная и снятая в офисе, на второй станции (цех ↔ выбор линии);
    - станция на архивной линии;
    - отзыв станции с открытым потоком и отзыв устройства, которым пользуется сам администратор;
    - «Новый код», затем старый код на другом ПК — «код истёк»;
  - двойной щелчок настоящей мышью и Enter в поле формы в WebView2 — тесты посылают события напрямую;
  - `a_refresh_that_finds_the_same_line_writes_nothing` на Windows: там проверяется только содержимое `device.json`, проверка inode — только Unix;
  - задание CI `standalone-windows-build` — для него нужен push.

---

## Перенесено

- План 1d4 (из брифа):
  - экраны операторов и бейджей: табельный номер, имя, должность, PIN и бейдж с хешами `@markiro/domain`, диалог бейджа, соль бейджей, конфликты (`login`, `badge`); решить, отдавать ли `operatorId` в `details` конфликта `badge`;
  - локальные копии операторов и бейджей на станции: миграция оболочки, строгие записи (`z.strictObject`) и подъём `SYNC_SCHEMA_VERSION`, без внешнего ключа от бейджей к операторам, защита upsert от более новой записи карантина (`AND NOT EXISTS`), хеш бейджа ровно со 100 000 итераций как именованная константа, остановка входа по PIN и бейджу офлайн после отзыва, отказа или сброса устройства (обеспечивает план 1f);
  - `secure_delete` и `wal_checkpoint(TRUNCATE)` или `VACUUM` после очистки копий; сброс, когда локальная база не открылась;
  - схемы Zod для фикстур людей, которые план 1d3 не берёт: `office-operator.json`, `operator-create.json`, `operator-update.json`, `badge-create.json`, `badge-salt.json`, `changes-people.json` (правило «Protocol»: фикстура без схемы — до плана 1d4);
  - фраза в `AGENTS.md`, что `reason` карантина безопасен только при схемах с фиксированными ключами (из «Перенесено» плана 1d1);
  - комментарии «plan 1d3» в `src/local/reference-sync.ts`, `src-tauri/src/local_db.rs` и `test/reference-sync.test.ts` — про операторов и бейджи, теперь это план 1d4; исправить вместе с ними.
- Из «Перенесено» плана 1d2, не вошедшее в бриф: экран «Устройства» предупреждает, что отзыв своего устройства завершит сессию. Для этого офису нужен `deviceId` этого ПК (сейчас `Office` его не получает). Решает контроллер: план 1d4 или 5.
- План 1e: `useCan("editCatalog")` для каталога и шаблонов; предел бюджета порции синхронизации E = 8 (30 из 32 операторов).
- План 2a: как назначенная или снятая в офисе линия ведёт себя при смене в работе; станция на архивной линии.
- План 5: `MIN_PROTOCOL_VERSION` и политика версий протокола после выпуска; живые коды подключения переживают права создателя; откат системных часов после замены кода.
- Решения владельца ждут: уникальность контрагента по ИНН или GLN (сейчас повтор запроса после потерянного ответа создаёт дубликат; двойной щелчок — нет); контрольный символ в коде подключения; защита от отката системных часов.
