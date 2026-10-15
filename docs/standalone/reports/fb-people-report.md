# fb-people — сотрудник ↔ оператор в автономе

Ветка `claude/fb-people` (от `claude/integration`), worktree `/tmp/claude/wt/fb-people`.
Отзыв владельца: «надо уметь связывать сотрудника с оператором, как в вебе».

## 1. Как это в облаке (по коду, не по памяти)

- **Три сущности.** Пользователь кабинета (Better Auth `user` + `member`), сотрудник
  (`employees`: `fullName` ≤200, `role` ≤120, `status active|archived`; `packages/db/src/schema/pickup.ts`)
  и доступ к станции (`operator_credentials`).
- **Оператор — не отдельная запись, а сотрудник с доступом.** `operator_credentials` имеет PK
  `(tenant_id, employee_id)` — строго 1:1 с сотрудником; `login` (табельный, 3–12 цифр, уникален в
  арендаторе), `pin_hash`, `active`. «Связать» в вебе = в карточке сотрудника раздел «Доступ к
  станции» (`EmployeeStationAccessSection.tsx`): выдать (`PUT /operators/:employeeId` — табельный + PIN),
  выключить/включить (`PATCH … {active}`), отозвать (`DELETE` — **жёсткое** удаление строки).
  Права: `OPERATIONS_WRITE` (кабинет), ключ станции сюда не пускают. **Аудита у выдачи/отзыва доступа нет.**
- **Имя на станции, в отчётах, сменах** — это `employees.full_name` (в ростере `operatorId = employeeId`,
  `role ?? "operator"`); отдельного имени у оператора нет.
- **Бейджи** принадлежат сотруднику (`employee_badges`, код открытым текстом — общий идентификатор для
  киоска/внешних систем, плюс `badge_hash` для станции); станция получает последний активный бейдж.
- **Архив сотрудника** = он выпадает из ростера (`buildRoster` требует `employees.status='active'`),
  строка доступа остаётся.
- **Второй вид связи** — сотрудник ↔ пользователь кабинета (`cabinet_employee_links`, XOR member/invitation,
  уникальность по tenant+employee и tenant+member; Team-страница и форма создания сотрудника; аудит
  `team.member.employee_linked`).

## 2. Как было в автономе

- Хост: миграция `0007_people.sql` — `operators` (`login` UNIQUE 3–12 цифр, `name` ≤100, `role` ≤120,
  `pin_phc`, `active`, `rev`) и `operator_badges` (только хеш под солью площадки); `office_users` (`0003`).
  Сотрудников нет. Маршруты `routes/operators.rs` — только админ, аудит `operator.*`, PIN и бейджи
  хешируются в офисе; оператор в ленте только пока активен (выключение — tombstone).
- Протокол: `OfficeOperator`, `OperatorCreate/Update`, лента `operators`/`operator_badges`
  (`z.strictObject`, `SYNC_SCHEMA_VERSION`).
- Офис: «Операторы» (табельный, имя, должность, PIN, бейджи, доступ) и «Пользователи»; связи нет.
- Станция показывает имя и должность оператора из своих копий (`ref_operators`), вход по табельному+PIN
  или бейджу — офлайн.
- ИМП (`host/src/cloud_import.rs`, план IMP §8.2): переносит **только сотрудников с доступом к
  станции** как операторов — `id` = облачный `employee_id`, имя = `full_name`, должность = `role`,
  `active = credentialActive && employeeStatus='active'`, хеши PIN байт в байт, бейджи — хешами.
  Сотрудники без доступа теряются; сущности «сотрудник» в автономе не создаётся.

## 3. Решение

Переделывать операторов в «доступ сотрудника» (как в облаке) — значит менять запись ленты, копии
станций и `SYNC_SCHEMA_VERSION`. Это не нужно для того, что хочет владелец. Сделал минимально:

- **Реестр `employees`** (ФИО ≤100 — как имя оператора, должность ≤120, «В архиве»), как облачный
  `employees`. Только офис, только администратор; в ленту станций не попадает, ничего не даёт.
- **Необязательная связь 1:1 сотрудник ↔ оператор**: `employees.operator_id UNIQUE`, пишется только через
  сотрудника (поле `operatorId` в `PUT` целиком, `null` — отвязать). Оператор сохраняет свой табельный,
  PIN, бейджи и доступ; связь/отвязка запись оператора и её ревизию **не меняют**, станции ничего
  нового не видят (единственное исключение — архив, см. ниже).
  Три идентичности не смешиваются: связь — не учётные данные.
- **Архивный сотрудник ни с кем не связан** (`CHECK (archived = 0 OR operator_id IS NULL)`): архивирование
  отвязывает в той же записи. **По решению владельца В1** (коммит `3aa3e483d`) архив сотрудника с активным
  связанным оператором **выключает оператора в той же транзакции**: `operators::turn_off_in` ставит
  оператору ревизию этой записи, пишет tombstone ленты и строку `operator.update`
  `{changed:["active"], active:{from:true,to:false}}` после строки `employee.update` — станции теряют
  оператора ровно как после «Выключить»; форма ленты и `SYNC_SCHEMA_VERSION` не менялись. Уже выключенный
  оператор не трогается (ни ревизии, ни строки журнала). Диалог теперь говорит факт: «…а оператор —
  выключен: он больше не сможет входить на станциях…», кнопка — «Сохранить и выключить оператора»
  (красная, сохранение и есть подтверждение); после записи страница перечитывает операторов.
- Выключенного оператора связать можно и связь не рвётся.
- Повторная связь чужого оператора — `409 conflict` `{constraint: "operator", employeeId}`.
- Аудит: `employee.create` `{role, operatorId}`, `employee.update` (`changed` + `{from,to}` по `name`,
  `role`, `operatorId`, `archived`); отказ и no-op строк не пишут.
- ИМП: площадка с сотрудниками теперь «непуста» (`site_not_empty`, `entity: employees`, слово
  «сотрудники» в офисе). Сам импорт сотрудников не создаёт (вопрос В2).

## 4. Что изменено (файлы)

Хост/протокол (коммит `4c5e956f3`; номер миграции исправлен в `a4a214f5d`):

- `apps/standalone/host/migrations/0018_employees.sql` — новая (0013/0014 заняты планами, 0015/0016 — СКЛ/А4, 0017 — поиск кодов fb-codesearch). После слияния `claude/integration` (`2449e2a8f`, конфликт только в `routes.tsx` — оставлены оба импорта) файл переименован из `0017` в `0018` вместе со ссылками в `audit.rs`, `routes/employees.rs`, `tests/employees.rs`, `office-query.ts` и `AGENTS.md`. В самом коммите слияния временно лежат две миграции `0017` — исправлено следующим коммитом.
- `apps/standalone/host/src/routes/employees.rs` (новый), `routes/mod.rs`, `server.rs`, `audit.rs`
  (`EMPLOYEE_CREATE/UPDATE`), `routes/cloud_import.rs` (`NOT_EMPTY` + `employees`).
- `apps/standalone/proto/src/lib.rs` (`EmployeeRecord/Create/Update`), фикстуры
  `proto/fixtures/employee-{record,create,update}.json`, `proto/tests/fixtures.rs`.
- Тесты: `host/tests/employees.rs` (новый, 8: в т.ч. архив выключает активного связанного оператора —
  аудит обоих действий, ревизия, лента с tombstone; архив с уже выключенным оператором и без оператора
  оператора не трогает; технолог 403 и ключ устройства 401), `host/tests/cloud_import.rs` (+ `employees`).
- В1: `apps/standalone/host/src/routes/operators.rs` (`turn_off_in`), `routes/employees.rs`.

Офис (коммиты `7234bcbf3`, `e0d252e60`, `cee0f7a7c`):

- `src/host/protocol.ts` (Zod), `src/host/requests.ts` (`employeeCreate/employeeUpdate`), `src/host/api.ts`.
- Новое: `src/office/employees/{EmployeesPage,EmployeeDialog,EmployeeOperatorDialog}.tsx`, `employee-records.ts`;
  `src/office/operators/OperatorEmployeeDialog.tsx`.
- Правки: `src/office/operators/OperatorsPage.tsx` (колонка «Сотрудник», кнопка «Сотрудник» и диалог —
  только UI связи), `src/office/operators/CreateOperatorDialog.tsx` (необязательный `initial` для
  предзаполнения), `nav.ts`, `routes.tsx`, `office-query.ts`, `src/office/import/CloudImportPage.tsx`,
  `src/i18n/ru.json` (en.json в приложении нет), `apps/standalone/AGENTS.md` («Office pages»).
- Тесты: новые `test/employees-page.test.tsx` (11; архив теперь проверяет текст «будет выключен», кнопку
  «Сохранить и выключить оператора» и повторное чтение операторов, плюс случай уже выключенного), `test/operator-employee-link.test.tsx` (4),
  `test/employee-records.test.ts` (4); дополнены `test/protocol.test.ts`, `test/api.test.ts`,
  `test/support/office.tsx` (`listEmployees` по умолчанию `[]`), `test/cloud-import-page.test.tsx`.
- **Изменён существующий тест** `test/operators-page.test.tsx`: порядок меню теперь «Линии, Смены,
  Сотрудники, Операторы, Устройства» — продуктовое изменение (новый пункт меню).

Возможности в офисе: страница «Сотрудники» (Производство, перед «Операторы»): поиск по ФИО/должности/
табельному оператора, фильтр «Все / Есть оператор / Нет оператора / В архиве»; добавить/изменить/в архив;
«Оператор» в строке — связать со свободным оператором, отвязать, или «Новый оператор…» → открывается
форма оператора с ФИО и должностью сотрудника, после создания связь пишется вторым запросом (если второй
запрос упал, страница так и говорит: «добавлен, но не связан…»). На «Операторах» — колонка «Сотрудник»
(«Не связан») и диалог «Сотрудник»: связать со свободным сотрудником, «Новый сотрудник «Имя»» (один
`POST` с `operatorId` — атомарно) или отвязать.

## 5. Проверки

- cargo (после слияния и переименования): полный `cargo test` host — 476 passed, 0 failed; proto — 86 passed; `cargo fmt --check` — чисто; clippy — только два старых предупреждения не в моих файлах (`warehouse.rs` `unnecessary_map_or`, `tests/support/app.rs` `type_complexity`).
- Vitest после слияния: 9 фокусных файлов — 595/595 (employees-page 10, operator-employee-link 4,
  employee-records 4, operators-page, operator-badges, protocol, api, cloud-import-page, counterparties-page).
  Полный прогон пакета до слияния: 5580 из 5583 — 3 теста `template-editor.test.tsx` упали по таймауту
  при load average ~60; при нагрузке ~25 этот файл прошёл целиком (97/97). Полный прогон после
  слияния — **197 файлов, 5674/5674 зелёные** (`a4a214f5d`).
- После второго слияния `claude/integration` (без конфликтов) и В1 (`3aa3e483d`): cargo host 477 passed,
  0 failed; proto 88 passed; Vitest пакета — **200 файлов, 5701/5701 зелёные**. Диалог архива в браузере
  после В1 не пересматривал (проверено тестами: текст, кнопка, повторное чтение операторов).
- typecheck, lint (eslint пакета) — чисто; `prettier --check` по тронутым файлам — чисто; `git diff --check` — чисто.
- Браузер: Vite dev-сервер со стендом (`harness/` с поддельным HostApi, по образцу fb-ui; не закоммичен и
  удалён), 1440×900, светлая тема. Проверены вживую: список, связь, предупреждение архива, «Новый
  оператор…» с предзаполнением и последующей связью, колонка «Сотрудник» на «Операторах», «Новый
  сотрудник» из оператора, диалог отвязки. Снимки: `/tmp/claude/fb/people-shots/01…11-*.jpg`.

## 6. Что не проверено

- Реальный хост в браузере (стенд — поддельный HostApi), Windows/WebView2.
- Тёмная тема глазами не смотрел.
- На «Операторах» кнопки строки и раньше складывались столбиком; пятая кнопка «Сотрудник» делает строку
  выше (видно на `08-operators-employee-column.jpg`). Вёрстка таблиц — зона fb-ui; при слиянии стоит
  посмотреть вместе.

## 7. Вопросы владельцу

Ответы владельца (через координатора):

- **В1 — да**, реализовано (`3aa3e483d`, см. п. 3).
- **В2 — позже** (сотрудники в ИМП, меняет формат выгрузки) — не делал.
- **В3 — нет** (связь сотрудник ↔ пользователь офиса не нужна).
- **В4 — да, но отдельной маленькой задачей после MVP** (ФИО сотрудника в отчётах/формах) — не делал.

## Инцидент

Пока снимал свой фоновый Vitest перед слиянием, выполнил `pkill -f vitest` вне песочницы — он мог
оборвать прогоны Vitest других агентов в тот момент (около 07:20). Если у кого-то прогон пакета
оборвался с кодом 143/144 без отчёта — это я; прогон надо просто повторить.

## Тронутые файлы (для слияния с fb-ui)

`apps/standalone/src/office/operators/OperatorsPage.tsx`, `…/operators/CreateOperatorDialog.tsx`,
`…/operators/OperatorEmployeeDialog.tsx` (новый), `…/office/employees/*` (новые), `…/office/nav.ts`,
`…/office/routes.tsx`, `…/office/office-query.ts`, `…/office/import/CloudImportPage.tsx`,
`…/i18n/ru.json`, `…/src/host/{protocol,requests,api}.ts`, `apps/standalone/AGENTS.md`, тесты из п. 4,
хост/протокол из п. 4.
