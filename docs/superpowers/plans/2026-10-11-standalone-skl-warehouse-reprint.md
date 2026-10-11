# План СКЛ: склад — повторная печать этикеток (код единицы, короб, паллета любой станции и любой смены; причина, шаблоны со списком и предпросмотром, сеанс с паузой и завершением, проверка оператора, неизвестный исход без самоповтора, записи на хост) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На станции автономного продукта появляется режим «Повторная печать этикеток», как в облачной станции после PR #693/#695/#697: с экрана смен оператор (вошедший офлайн по PIN или бейджу) открывает сеанс перепечатки, выбирает причину и шаблоны (коды единиц, короба, паллеты — список с поиском и предпросмотром), сканирует Data Matrix единицы или SSCC короба или паллеты (либо вводит вручную) — хост находит запись своей площадки по любой станции и любой смене, закрытой тоже, — и станция печатает одну этикетку на назначенный принтер, не создавая новой единицы, короба или SSCC. Старая этикетка короба с ошибочным `!1` находит тот же короб. Повтор кода в сеансе без явного «Напечатать ещё раз» с причиной не печатается; неизвестный исход отправки никогда не повторяется сам; сеанс ставится на паузу («К сменам») и завершается с подтверждением. Каждая попытка оставляет запись, которая уходит на хост отдельным идемпотентным маршрутом и хранится там как след перепечатки. Без связи с хостом поиск честно недоступен.

**Architecture:**

- Протокол (задача 1): типы `WarehouseLookup`, `WarehouseLookupResult`, `WarehouseSource`, `WarehouseRecord`, `WarehouseBatch` в `proto`, коды отказа `warehouse_receipt_codes`, фикстуры `proto/fixtures/warehouse-*.json`, их Zod-зеркала в `src/host/protocol.ts`, методы `HostApi.warehouseLookup` и `HostApi.sendWarehouseRecords`.
- Хост (задачи 2–3): `host/src/routes/warehouse.rs` — `POST /v1/device/warehouse/lookup` (поиск по `code_owners`, `boxes.sscc`, `pallets.sscc` одним снимком; поля этикетки из снимка смены) и `POST /v1/device/warehouse/reprints` (пакет 1–100 записей, квитанции как у фактов, таблица `warehouse_reprints`, миграция хоста `0015_warehouse_reprints.sql`); оба маршрута держит восстановление (`held_by_a_restore`).
- База станции (задача 4): миграция оболочки `0012_warehouse_reprint.sql` — `wh_sessions`, `wh_jobs`, `wh_outbox` (`DeviceData`), модуль `src/floor/warehouse/warehouse-store.ts`, хранение 30 дней, планы запросов в `test/floor-schema.test.ts` и `src-tauri/tests/local_db.rs`.
- Логика (задача 5): `src/floor/warehouse/warehouse-templates.ts` (шаблоны из копий, выбор по умолчанию, проверка пригодности) и `src/floor/warehouse/warehouse-work.ts` (скан → поиск → поля → рендер → задание → отправка → запись; повтор, отмена, проверка сканом, восстановление прерванной отправки); `renderLabel` получает необязательный `kmDataMatrix`.
- Доставка (задача 6): `src/local/warehouse-sender.ts`; связь (`useHostLink`) отправляет записи после пакета фактов, по тем же правилам; хранение запускается вместе с почасовой очисткой.
- Экран (задачи 7–8): `WarehouseScreen.tsx`, `TemplatePicker.tsx`, кнопка «Повторная печать этикеток» в списке смен, вид `warehouse` в `FloorApp`, тексты `floor.warehouse.*`; документы — `apps/standalone/AGENTS.md` («Warehouse reprint», «Verification»), раздел 30 спецификации пилота.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button size="floor"`, `Input size="floor"`, `Alert`), `@markiro/domain` (`resolveWarehouseReprintScan`, `compareWarehouseReprintLabel`, `boxLabelFields`, `palletLabelFields`, `parseDuplicateKm`, `assertDuplicateTemplate`, `labelTemplateUsesField`, `labelTemplateSpecSchema`, `DomainError`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`; Rust — axum, sqlx 0.8.6, serde.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — спецификация пилота (§4.2 откладывала перепечатку по коду; решение владельца 2026-10-11 её переносит), новый раздел 30 пишет задача 8.
- `.superpowers/sdd/OWNER-DECISIONS.md`, «DECISIONS 2026-10-11»: перенести в автономную станцию новую логику облачной, в том числе складскую перепечатку (#693/#695/#697); максимальная скорость; после всех планов — push и первая бета.
- `.superpowers/sdd/new-plans-context.md` — распределение номеров: миграция оболочки СКЛ = `0012`, хоста = `0015`, раздел спецификации = 30; поток WH не зависит от незалитого кода потоков PRT (ДРВ, A4) и MISC (ХП, I1, ОЧ).
- Облачный образец поведения (не архитектура): `docs/superpowers/specs/2026-10-09-station-warehouse-reprint-design.md`; `apps/station/src/lib/warehouse-reprint/*` (`work.ts`, `printing.ts`, `store.ts`, `templates.ts`), `apps/station/src/pages/WarehouseReprint.tsx`, `apps/station/src/ui/warehouse-reprint/TemplatePicker.tsx`, `apps/station/src/ui/labels/TemplateChoiceList.tsx`, `apps/api/src/modules/station-warehouse-reprint/*`; `packages/domain/src/warehouse-reprint/{scan,contracts,state,template}.ts`. Коммиты: `cd1fa6021` (#693), `3f59c4232` (#695), `c4b356805` (#697); `80eb79d75` (#701) — сверка коробов облака, к автономному продукту не относится (в нём нет облачной сверки).
- `apps/standalone/AGENTS.md`: «Three identities», «Writes», «Facts», «Floor work», «Floor printing», «Floor exceptions and close», «Backups and restore», «Logs», «Verification».

## Допущения

Планировщик принимает решения сам (контроллер решает вопросы владельцу по рекомендации); каждое — с причиной.

- **Р1 — свой маршрут хоста, а не факты.** Факт называет смену, в которую станция вошла (`not_entered` иначе), а складская перепечатка от смены не зависит: короб чужой станции и закрытой смены. Маршрут `POST /v1/device/warehouse/reprints` повторяет форму фактов (пакет 1–100, квитанция на запись по месту, `FactReceipts`, дайджест записи, `payload_mismatch`), но свои коды отказа (`invalid_record`, `payload_mismatch`, `subject_unknown`) и своя таблица. `fact-receipt-codes.json` и `FACT_RECEIPT_CODES` не меняются.
- **Р2 — поиск только на хосте.** Площадка одна, хост в сети цеха; станция не держит базу чужих станций. Без связи экран говорит «Нет связи с хостом: найти код нельзя» и ничего не печатает; это не «код не найден». Повтор уже отправленного задания (байты сохранены) и решение неизвестного исхода работают без хоста.
- **Р3 — паллеты входят.** В облаке MVP паллеты отказывал; у автономного продукта паллеты есть (ПЛ-Х/ПЛ-Ц), данные на хосте, шаблон назначения `pallet` и принтер назначения `pallet` есть. Печатается термоэтикетка паллеты (`palletLabelFields`); листы A4 паллеты — план A4, не этот.
- **Р4 — запись на попытку, а не цепочка событий.** Облако шлёт события `prepared/sending/sent/...` с порядком; здесь одна запись на исход попытки (`sent`, `unknown`, `failed`, `verified`, `cancelled`) пишется той же транзакцией, что новое состояние задания. Хост проверяет форму и существование предмета (`subject_unknown`), принятые хранит навсегда; отказ не хранится (повтор того же пакета получает тот же ответ по тем же правилам).
- **Р5 — след на хосте — таблица `warehouse_reprints`.** Записи — производственные данные, как факты: строки `audit_log` и ревизии не пишутся (правило «Facts are production data: they write no audit row»). Страница офиса с историей перепечаток — «Перенесено».
- **Р6 — миграции.** Оболочка `0012_warehouse_reprint.sql` неизбежна: состояние `sending` и неизвестный исход переживают перезапуск, а `floor_print_jobs` (CHECK: `purpose IN ('box','pallet')`, `sscc` 18 цифр, `shift_id NOT NULL`) задание кода единицы и задание без смены не примет. Хост `0015_warehouse_reprints.sql`. В потоке WH номера `0010`/`0011` оболочки и `0013`/`0014` хоста отсутствуют: sqlx применяет недостающие младшие миграции позже (`host/tests/backup_schema.rs` это и проверяет), а тест журнала оболочки (`opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`) задача 4 переводит со сплошного `1..=count` на версии самого `MIGRATOR`.
- **Р7 — `PROTOCOL_VERSION` не растёт.** Новые маршруты, а не новый вид факта: старый хост отвечает `404 not_found`, станция говорит «Хост не поддерживает повторную печать. Обновите хост» (хост и станция ставятся одним установщиком). Записи к старому хосту не уходят и ждут.
- **Р8 — шаблоны — копии станции.** Список строится из `ref_templates` (офлайн): включённые шаблоны назначения (`product_duplicate`, `box`, `pallet`) с читаемым макетом. Начальный выбор: шаблон по умолчанию организации (`ref_org.default_*_template_id`), если он включён и читается; иначе единственный подходящий; иначе пусто (выбирает оператор). Пригодность проверяется при подготовке по категории ЧЗ товара найденной записи (`templateFitsSlot`), для единицы ещё `assertDuplicateTemplate`, для короба и паллеты — макет с `sscc` и без `km.code`. Незаметной подстановки другого шаблона нет. Макет и поля замораживаются в задании (`template_spec`, `fields`).
- **Р9 — причины облака:** `not_printed` «Не напечаталась», `damaged` «Повреждена», `lost` «Утеряна». Причина выбирается до первого скана, меняется для следующих заданий; новая попытка («Напечатать ещё раз») спрашивает свою причину.
- **Р10 — одно нерешённое задание на сеанс.** Уникальный частичный индекс `wh_jobs_open` держит не больше одного задания в `prepared`/`sending`/`failed`/`unknown`; пока оно есть, новый код не печатается («Сначала решите текущую печать»), а сеанс не завершается. Работа экрана идёт очередью (`createWorkQueue`) и вся передаётся `track` (N9: уход ждёт её).
- **Р11 — исходы.** `failed` (ничего не ушло с компьютера) — «Повторить» без причины (рендер заново на принтер назначения, если его язык или разрешение другие) или «Отменить печать» (`cancelled`). `unknown` — «Проверить сканом» (скан новой этикетки строго сравнивается `compareWarehouseReprintLabel`; скан старой с `!1` её не подтверждает) или «Напечатать ещё раз» с причиной. `sent`/`verified` — «Напечатать ещё раз» с причиной. `prepared`, найденный после перезапуска, отправляется явно кнопкой «Отправить». `sending` без отправки в процессе при открытии экрана — `unknown` с `interrupted`. Ничего не отправляется само.
- **Р12 — сеанс.** Пауза — «К сменам»: открытый сеанс продолжается при следующем входе любым оператором (каждое задание и каждая запись несут своего оператора). «Завершить сеанс» — с подтверждением, только без нерешённого задания; завершённый сеанс не продолжается. Одна открытая сессия на подключение (`wh_sessions_open`).
- **Р13 — проверка оператора** перед каждой подготовкой: `readOperatorCopy` текущего слота копий (отключённый офисом или в карантине оператор ничего не печатает). Три идентичности не смешиваются: оператор — копии станции (PIN/бейдж офлайн), хост — ключ устройства, офисная сессия не нужна.
- **Р14 — печать через существующую машинку.** `resolvePrinter` по назначениям `duplicate` (единица), `box`, `pallet`; `renderLabel` (с новым необязательным `options.kmDataMatrix = "raster"` для единицы, как облачный дубль); `PrintRuntime.send` (сериализация по принтеру, предел 20 с, `busy`/`timeout`); `settleOutcome`. План ДРВ (печать через драйвер Windows) меняет `renderLabel`/профиль принтера — СКЛ получает драйверный путь сам, без зависимости: если ДРВ влит раньше, правка `renderLabel` этой задачи применяется к его версии по смыслу (параметр `options` доходит до эмиттеров ZPL/TSPL; растровый путь драйвера рисует Data Matrix растром и так).
- **Р15 — данные этикетки с хоста:** продукт и контрагент — из снимка смены (`shifts.snapshot`), номер смены (`format_number`), дата производства смены, момент — скан единицы или закрытие короба/паллеты (исторические даты, `boxLabelFields`/`palletLabelFields` считают срок годности от них), количество короба — `item_count_reported` (что было напечатано), паллеты — `box_count_reported` и сумма `item_count_reported` её нерасформированных коробов на момент поиска, имя оператора — из `operators` по `operator_id` записи. Полный канонический код единицы (с GS и криптохвостом) — `scans.canonical` владеющего скана; код без криптохвоста печать запрещает (`parseDuplicateKm`).
- **Р16 — недоступные записи:** код, освобождённый исключением (в реестре нет владельца, но `ok`-скан был), — `released`; расформированный короб или паллета — `disassembled`; открытый короб SSCC не имеет — `not_found`.
- **Р17 — доставка записей** — тот же планировщик, что факты (`factSender` в `useHostLink`), после пакета фактов, когда фактов больше нет; ошибка отправки записей (кроме отказа ключа и смены сертификата) не трогает состояние фактов в строке статуса и повторяется при следующей доставке. Восстановление хоста держит и эти маршруты (`restore_pending`).
- **Р18 — хранение:** завершённый сеанс, все записи которого приняты (`outcome = 'accepted'`), удаляется со своими заданиями и записями через 30 дней после завершения; отказанные записи держат сеанс навсегда (как отказанный факт держит смену).
- **Р19 — вход в режим** — кнопка «Повторная печать этикеток» в списке смен рядом с «Рабочее место»; без `warehouseLookup` у `FloorApp` (старые тесты) кнопки нет. Из экрана — «Рабочее место» (при `printer_unconfigured`) и возврат в тот же сеанс.
- **Р20 — ручной ввод** («Ввести код вручную») — поле на весь код или 18 цифр SSCC, Enter или кнопка, Escape — отмена; пока поле открыто, сканы не печатают (`setManualTextEntryActive`).

## Global Constraints

**Порядок владельца (DECISIONS 2026-10-11, дословно по смыслу)**

- Перенести в автономную станцию новую логику облачной станции, в том числе складскую повторную печать (#693/#695/#697); после всех доработок — push, первая бета, владелец тестирует локально. Максимальная скорость: задачи исполняются по одной свежим исполнителем.

**Правила продукта**

- Офлайн-первым: запись задания, состояние `sending` до передачи, неизвестный исход сохраняются в SQLite станции и переживают перезапуск; неизвестный исход никогда не отправляется повторно сам.
- Идемпотентная синхронизация: запись с тем же `id` и тем же содержанием получает ту же квитанцию; с другим содержанием — `payload_mismatch`.
- Перепечатка не создаёт идентичность: не пишет факты, не трогает `boxes`, `pallets`, `code_owners`, блоки SSCC и курсоры.
- Полный код единицы — только в теле ответа хоста и в байтах этикетки: не в URL, не в журналах (`tracing`, `console.*`), не в записях (запись несёт хеш кода).
- Разделитель GS1 `\u001d` сохраняется; поиск по коду — `kmHash` (без криптохвоста), печать — полный `canonical`.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках (`as const` — не приведение); именованные экспорты, `import type`.
- Экраны цеха: только `@markiro/ui`, каждая кнопка — `size="floor"` (64 px), состояние — словами (не только цветом); кнопка ухода не держится запросом.
- Тексты — ключи `src/i18n/ru.json`, кириллица буквами, ключи уникальны; переменные текстов именованные, не `count`.
- Каждый новый SQL на растущей таблице (`wh_jobs`, `wh_outbox`, `wh_sessions`) закреплён планом в `test/floor-schema.test.ts` (node:sqlite 3.53) **и** `src-tauri/tests/local_db.rs` (SQLite оболочки 3.46), тексты совпадают побайтно.
- Формы на проводе — фикстуры `proto/fixtures`, которые читают и Rust (`proto/tests/warehouse.rs`), и Vitest (`test/warehouse-protocol.test.ts`).
- Применённые миграции не меняются: оболочка `0001`–`0009`, хост `0001`–`0012`. СКЛ добавляет только оболочку `0012` и хост `0015`.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются. Не меняются `apps/station`, `packages/*`.
- Коммиты — явные пути (`git add <путь>`), сообщение из файла, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR — не в этом плане.

## Заметки для исполнения

**Основа**

- Поток WH исполняется в своём worktree от `claude/integration` (`2c726efba` или новее). Перед задачей 1 проверить, что есть `apps/standalone/src/floor/print/print-jobs.ts` (`settleOutcome`, `base64ToBytes`), `apps/standalone/src/floor/print/label-render.ts` (`renderLabel`), `apps/standalone/host/src/routes/codes.rs`, `apps/standalone/host/migrations/0012_pallets.sql`, `apps/standalone/src-tauri/migrations/0009_restore_epochs.sql`; если `0012` оболочки или `0015` хоста уже заняты — остановиться и спросить контроллера.
- Фрагменты «найти … заменить на …» взяты из настоящего дерева `2c726efba`. Если параллельный поток уже поменял место (ДРВ — `label-render.ts`, ХП — `test/floor-schema.test.ts`), правка применяется по смыслу, а расхождение записывается в «Отклонения при исполнении». Проверка фрагментов на копии не проводилась (скорость): исполнитель доводит код до зелёных проверок и записывает отклонения.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, не часть фрагмента.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install`/`pnpm add` не запускать. Команды — из корня репозитория, без `cd`. `git stash` не использовать. Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`; перед `cargo test -p markiro-standalone` — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (`tauri::generate_context!` читает `apps/standalone/dist`).
- Cargo — с `--offline --locked`. `--test local_db` оболочки и тесты хоста на `TestApp` сокета не открывают.
- React 19.2 запускает пассивные эффекты через `setImmediate`, `waitFor` ждёт `setTimeout(0)`: тесты экрана ждут подписки сканера (`listening()`), сканируют и нажимают внутри асинхронного `act`, который дожидается ворот работы (`gate.drain()`), итог ждут через `findBy*`. Новые тестовые файлы с React (задачи 7–8) запускаются один раз с `--reporter=verbose` (в выводе нет `stderr |`) и один раз под стендом с задержкой `setImmediate` на 3 мс — два временных файла, удалить сразу после прогона:

  `apps/standalone/test/delayed-immediate.setup.ts`:

  <!-- prettier-ignore -->
  ```ts
  // Temporary stand (never committed): React's scheduler runs passive effects
  // through `setImmediate`; delaying it by 3 ms makes every effect lose the race
  // with Testing Library's `setTimeout(0)`.
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setImmediate", {
    configurable: true,
    writable: true,
    value: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      realSetTimeout(callback, 3, ...args),
  });
  ```

  `apps/standalone/vitest.delay.config.ts`:

  <!-- prettier-ignore -->
  ```ts
  import react from "@vitejs/plugin-react";
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      globals: true,
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["test/delayed-immediate.setup.ts", "test/setup.ts"],
    },
  });
  ```

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --ignore-path .prettierignore --check` на изменённые TS, TSX, JSON, CSS, MD; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; при правке Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — единственное совпадение `src/host/pairing-code.ts:66`.

## Файлы

- Создать: `apps/standalone/proto/fixtures/warehouse-lookup-code.json`, `warehouse-lookup-sscc.json`, `warehouse-lookup-found-unit.json`, `warehouse-lookup-found-pallet.json`, `warehouse-lookup-not-found.json`, `warehouse-lookup-unavailable.json`, `warehouse-records-request.json`, `warehouse-records-response.json`, `warehouse-receipt-codes.json`; `apps/standalone/proto/tests/warehouse.rs`; `apps/standalone/test/warehouse-protocol.test.ts`.
- Создать: `apps/standalone/host/migrations/0015_warehouse_reprints.sql`, `apps/standalone/host/src/routes/warehouse.rs`, `apps/standalone/host/tests/warehouse.rs`.
- Создать: `apps/standalone/src-tauri/migrations/0012_warehouse_reprint.sql`; `apps/standalone/src/floor/warehouse/warehouse-store.ts`, `warehouse-templates.ts`, `warehouse-work.ts`, `WarehouseScreen.tsx`, `TemplatePicker.tsx`; `apps/standalone/src/local/warehouse-sender.ts`; `apps/standalone/test/support/warehouse.ts`, `apps/standalone/test/warehouse-store.test.ts`, `warehouse-work.test.ts`, `warehouse-sender.test.ts`, `warehouse-screen.test.tsx`.
- Изменить: `apps/standalone/proto/src/lib.rs`; `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`; `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/src-tauri/tests/local_db.rs`; `apps/standalone/src/host/protocol.ts`, `src/host/api.ts`; `src/floor/print/label-render.ts`; `src/app/host-link.ts`, `src/app/App.tsx`; `src/floor/FloorApp.tsx`, `src/floor/shifts/ShiftList.tsx`; `src/i18n/ru.json`; `src/app/shell.css`; `test/support/office.tsx`, `test/api.test.ts`, `test/floor-schema.test.ts`, `test/floor-app.test.tsx`; `apps/standalone/AGENTS.md`; `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`.

---

## Задача 1: протокол складской перепечатки (proto, Zod, фикстуры, `HostApi`)

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs`
- Create: `apps/standalone/proto/fixtures/warehouse-*.json` (9 файлов), `apps/standalone/proto/tests/warehouse.rs`
- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`, `apps/standalone/test/api.test.ts`
- Create: `apps/standalone/test/warehouse-protocol.test.ts`

**Interfaces:**

- Rust: `WarehouseLookup { code_hash: Option<String>, sscc: Option<String> }`, `WarehouseSubjectKind { Unit, Box, Pallet }` (+`as_str`), `WarehouseUnavailable { Released, Disassembled }`, `WarehouseSource`, `WarehouseLookupResult { Found { source }, NotFound, Unavailable { reason } }`, `WarehouseRecord`, `WarehouseBatch`, `WAREHOUSE_REASONS`, `WAREHOUSE_OUTCOMES`, `warehouse_receipt_codes::{INVALID_RECORD, PAYLOAD_MISMATCH, SUBJECT_UNKNOWN, ALL}`.
- TS: `warehouseLookupSchema`, `warehouseSourceSchema`, `warehouseLookupResultSchema`, `warehouseRecordSchema`, `warehouseBatchSchema`, `WAREHOUSE_SUBJECT_KINDS`, `WAREHOUSE_UNAVAILABLE`, `WAREHOUSE_REASONS`, `WAREHOUSE_OUTCOMES`, `WAREHOUSE_RECEIPT_CODES`, типы `WarehouseLookup`, `WarehouseSource`, `WarehouseLookupResult`, `WarehouseRecord`, `WarehouseSubjectKind`; `HostApi.warehouseLookup(lookup)`, `HostApi.sendWarehouseRecords(records)`.

- [ ] **Шаг 1: фикстуры.** Создать девять файлов ровно так.

`apps/standalone/proto/fixtures/warehouse-lookup-code.json`:

<!-- prettier-ignore -->
```json
{ "codeHash": "7a6ad5f358a3f6d800e0550c5bc16079d73004e9766bfc13c572778c62a6657d" }
```

`apps/standalone/proto/fixtures/warehouse-lookup-sscc.json`:

<!-- prettier-ignore -->
```json
{ "sscc": "046006820000015000" }
```

`apps/standalone/proto/fixtures/warehouse-lookup-found-unit.json` (код `010460068200001321S000001` + GS + `93Tail`, его `kmHash` вычислен доменом):

<!-- prettier-ignore -->
```json
{
  "status": "found",
  "source": {
    "kind": "unit",
    "subjectId": "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
    "identity": "7a6ad5f358a3f6d800e0550c5bc16079d73004e9766bfc13c572778c62a6657d",
    "canonical": "010460068200001321S000001\u001d93Tail",
    "product": {
      "id": "8b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e",
      "gtin14": "04600682000013",
      "name": "Молоко 3,2% 0,9 л",
      "printName": "Молоко 3,2%",
      "chzProductGroupCode": 8,
      "shelfLifeDays": 10
    },
    "counterpartyName": null,
    "shiftId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "shiftNumber": "OCT26-003",
    "productionDate": "2026-10-08",
    "at": "2026-10-08T05:58:41.090Z",
    "itemCount": 1,
    "operatorName": "Анна Кузнецова",
    "deviceId": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
  }
}
```

`apps/standalone/proto/fixtures/warehouse-lookup-found-pallet.json`:

<!-- prettier-ignore -->
```json
{
  "status": "found",
  "source": {
    "kind": "pallet",
    "subjectId": "a0000000-0000-4000-8000-000000000001",
    "identity": "146006820000000409",
    "sscc": "146006820000000409",
    "product": {
      "id": "8b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e",
      "gtin14": "04600682000013",
      "name": "Молоко 3,2% 0,9 л",
      "printName": null,
      "chzProductGroupCode": 8,
      "shelfLifeDays": null
    },
    "counterpartyName": "ООО «Север»",
    "shiftId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "shiftNumber": "OCT26-003/S",
    "productionDate": "2026-10-08",
    "at": "2026-10-08T06:20:00.000Z",
    "itemCount": 480,
    "boxCount": 40,
    "operatorName": null,
    "deviceId": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
  }
}
```

`apps/standalone/proto/fixtures/warehouse-lookup-not-found.json`:

<!-- prettier-ignore -->
```json
{ "status": "not_found" }
```

`apps/standalone/proto/fixtures/warehouse-lookup-unavailable.json`:

<!-- prettier-ignore -->
```json
{ "status": "unavailable", "reason": "disassembled" }
```

`apps/standalone/proto/fixtures/warehouse-records-request.json`:

<!-- prettier-ignore -->
```json
{
  "records": [
    {
      "id": "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      "sessionId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      "jobId": "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
      "attempt": 1,
      "subjectKind": "box",
      "subjectId": "b0000000-0000-4000-8000-000000000001",
      "identity": "046006820000015000",
      "reasonCode": "damaged",
      "repair": "legacy_tspl_fnc1_literal",
      "templateId": "d1d1d1d1-0000-4000-8000-000000000002",
      "templateRev": 4,
      "outcome": "sent",
      "errorCode": null,
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "occurredAt": "2026-10-09T07:15:02.120Z"
    },
    {
      "id": "7f8a9b0c-1d2e-4f3a-9b4c-5d6e7f8a9b0c",
      "sessionId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      "jobId": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
      "attempt": 1,
      "subjectKind": "unit",
      "subjectId": "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
      "identity": "7a6ad5f358a3f6d800e0550c5bc16079d73004e9766bfc13c572778c62a6657d",
      "reasonCode": "not_printed",
      "repair": null,
      "templateId": "d1d1d1d1-0000-4000-8000-000000000001",
      "templateRev": 4,
      "outcome": "unknown",
      "errorCode": "timeout",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "occurredAt": "2026-10-09T07:16:40.005Z"
    }
  ]
}
```

`apps/standalone/proto/fixtures/warehouse-records-response.json`:

<!-- prettier-ignore -->
```json
{
  "receipts": [
    { "id": "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b", "outcome": "accepted" },
    {
      "id": "7f8a9b0c-1d2e-4f3a-9b4c-5d6e7f8a9b0c",
      "outcome": "rejected",
      "code": "subject_unknown"
    }
  ]
}
```

`apps/standalone/proto/fixtures/warehouse-receipt-codes.json`:

<!-- prettier-ignore -->
```json
{ "codes": ["invalid_record", "payload_mismatch", "subject_unknown"] }
```

- [ ] **Шаг 2: тест Rust (RED).** Создать `apps/standalone/proto/tests/warehouse.rs`:

<!-- prettier-ignore -->
```rust
//! The wire of the warehouse reprint (plan СКЛ): every fixture round-trips,
//! and the receipt codes are the fixture's, as the webview reads them.

use markiro_proto::{
    warehouse_receipt_codes, FactOutcome, FactReceipts, WarehouseBatch, WarehouseLookup,
    WarehouseLookupResult, WarehouseSubjectKind, WarehouseUnavailable, WAREHOUSE_OUTCOMES,
    WAREHOUSE_REASONS,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

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
fn a_lookup_asks_by_the_hash_of_a_code_or_by_an_sscc() {
    let code: WarehouseLookup = round_trip("warehouse-lookup-code.json");
    assert_eq!(code.sscc, None);
    assert_eq!(code.code_hash.as_deref().map(str::len), Some(64));
    let sscc: WarehouseLookup = round_trip("warehouse-lookup-sscc.json");
    assert_eq!(sscc.code_hash, None);
    assert_eq!(sscc.sscc.as_deref(), Some("046006820000015000"));
    // A field the host does not know is refused, not ignored.
    assert!(serde_json::from_value::<WarehouseLookup>(
        serde_json::json!({ "sscc": "046006820000015000", "raw": "x" })
    )
    .is_err());
}

#[test]
fn every_lookup_answer_round_trips() {
    let unit: WarehouseLookupResult = round_trip("warehouse-lookup-found-unit.json");
    let WarehouseLookupResult::Found { source } = unit else {
        panic!("the unit fixture is found");
    };
    assert_eq!(source.kind, WarehouseSubjectKind::Unit);
    assert!(source.canonical.as_deref().unwrap().contains('\u{1d}'));
    assert_eq!((source.sscc, source.box_count), (None, None));
    let pallet: WarehouseLookupResult = round_trip("warehouse-lookup-found-pallet.json");
    let WarehouseLookupResult::Found { source } = pallet else {
        panic!("the pallet fixture is found");
    };
    assert_eq!(source.kind, WarehouseSubjectKind::Pallet);
    assert_eq!(source.box_count, Some(40));
    assert_eq!(source.canonical, None);
    let missing: WarehouseLookupResult = round_trip("warehouse-lookup-not-found.json");
    assert_eq!(missing, WarehouseLookupResult::NotFound);
    let gone: WarehouseLookupResult = round_trip("warehouse-lookup-unavailable.json");
    assert_eq!(
        gone,
        WarehouseLookupResult::Unavailable {
            reason: WarehouseUnavailable::Disassembled
        }
    );
}

#[test]
fn records_round_trip_and_are_answered_with_fact_receipts() {
    let batch: WarehouseBatch = round_trip("warehouse-records-request.json");
    assert_eq!(batch.records.len(), 2);
    assert_eq!(batch.records[0].subject_kind.as_str(), "box");
    assert_eq!(batch.records[1].error_code.as_deref(), Some("timeout"));
    let receipts: FactReceipts = round_trip("warehouse-records-response.json");
    assert_eq!(receipts.receipts[0].outcome, FactOutcome::Accepted);
    assert_eq!(
        receipts.receipts[1].code.as_deref(),
        Some(warehouse_receipt_codes::SUBJECT_UNKNOWN)
    );
    let mut extra = fixture("warehouse-records-request.json")["records"][0].clone();
    extra["addedLater"] = Value::from(1);
    assert!(serde_json::from_value::<markiro_proto::WarehouseRecord>(extra).is_err());
}

#[test]
fn the_receipt_codes_reasons_and_outcomes_are_the_fixtures() {
    let codes = fixture("warehouse-receipt-codes.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(codes["codes"].clone()).unwrap(),
        warehouse_receipt_codes::ALL
    );
    assert_eq!(WAREHOUSE_REASONS, ["not_printed", "damaged", "lost"]);
    assert_eq!(
        WAREHOUSE_OUTCOMES,
        ["sent", "unknown", "failed", "verified", "cancelled"]
    );
}
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test warehouse` — ожидается FAIL: не собирается (`WarehouseLookup` и остальные не найдены).

- [ ] **Шаг 3: типы Rust.** В `apps/standalone/proto/src/lib.rs` найти:

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CodeCheck {
    Free,
    Taken { owner: CodeOwner },
}
```

и заменить на (блок `CodeCheck` остаётся, после него новые типы):

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CodeCheck {
    Free,
    Taken { owner: CodeOwner },
}

/// What a station looks up to print a label again (plan СКЛ, pilot spec
/// §30): `POST /v1/device/warehouse/lookup` with exactly one of the hash of
/// a unit's code (`kmHash`, 64 lower-case hex digits) and the 18 digits of a
/// box's or a pallet's SSCC. The full code never travels this way: the host
/// answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehouseLookup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sscc: Option<String>,
}

/// What a warehouse reprint prints: a unit's code, a box's or a pallet's
/// label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarehouseSubjectKind {
    Unit,
    Box,
    Pallet,
}

impl WarehouseSubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WarehouseSubjectKind::Unit => "unit",
            WarehouseSubjectKind::Box => "box",
            WarehouseSubjectKind::Pallet => "pallet",
        }
    }
}

/// Why a record the host has is not printed again: its code was freed by an
/// exception (`released`), or the box or the pallet was taken apart
/// (`disassembled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarehouseUnavailable {
    Released,
    Disassembled,
}

/// A record the host found, with what its label is rendered from: the
/// product and the counterparty as the shift froze them, the shift's number
/// and production date, `at` — the instant the label dates from (a unit's
/// scan, a box's or a pallet's close) — the counts it was printed with, the
/// name of the operator who scanned or closed it, and the station. A unit
/// carries its full canonical code (GS separators and crypto tail
/// included), a box and a pallet their SSCC; `identity` is what was asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseSource {
    pub kind: WarehouseSubjectKind,
    pub subject_id: String,
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sscc: Option<String>,
    pub product: ShiftSnapshotProduct,
    pub counterparty_name: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub production_date: String,
    pub at: String,
    pub item_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_count: Option<u32>,
    pub operator_name: Option<String>,
    pub device_id: String,
}

/// The answer of `POST /v1/device/warehouse/lookup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WarehouseLookupResult {
    Found { source: WarehouseSource },
    NotFound,
    Unavailable { reason: WarehouseUnavailable },
}

/// Why a station prints a label again (the cloud's `warehouseReasonSchema`).
pub const WAREHOUSE_REASONS: &[&str] = &["not_printed", "damaged", "lost"];

/// Where one attempt of a reprint ended, as the station recorded it.
pub const WAREHOUSE_OUTCOMES: &[&str] = &["sent", "unknown", "failed", "verified", "cancelled"];

/// The codes of a refused warehouse record
/// (`proto/fixtures/warehouse-receipt-codes.json`).
pub mod warehouse_receipt_codes {
    /// The record could not be read, or a field breaks its rule.
    pub const INVALID_RECORD: &str = "invalid_record";
    /// A record with this id was received before with other content.
    pub const PAYLOAD_MISMATCH: &str = "payload_mismatch";
    /// No unit, box or pallet of the host has this id and identity.
    pub const SUBJECT_UNKNOWN: &str = "subject_unknown";
    pub const ALL: &[&str] = &[INVALID_RECORD, PAYLOAD_MISMATCH, SUBJECT_UNKNOWN];
}

/// One attempt of a warehouse reprint, as the station recorded it: which
/// session and job, the attempt's number (0 — a job that never reached a
/// printer), what was printed (`subjectKind`, the host's `subjectId` and the
/// `identity` looked up: a code's hash or an SSCC, never a full code), why,
/// on which template revision, how it ended (`errorCode` exactly for
/// `failed` and `unknown`), by whom and when (a device instant).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehouseRecord {
    pub id: String,
    pub session_id: String,
    pub job_id: String,
    pub attempt: u32,
    pub subject_kind: WarehouseSubjectKind,
    pub subject_id: String,
    pub identity: String,
    pub reason_code: String,
    pub repair: Option<String>,
    pub template_id: String,
    pub template_rev: i64,
    pub outcome: String,
    pub error_code: Option<String>,
    pub operator_id: Option<String>,
    pub occurred_at: String,
}

/// `POST /v1/device/warehouse/reprints`: 1–100 records; the answer is
/// [`FactReceipts`], a receipt per record in their order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehouseBatch {
    pub records: Vec<WarehouseRecord>,
}
```

Run: та же команда — PASS (4 теста).

- [ ] **Шаг 4: тест Vitest (RED).** Создать `apps/standalone/test/warehouse-protocol.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  factReceiptsSchema,
  WAREHOUSE_OUTCOMES,
  WAREHOUSE_REASONS,
  WAREHOUSE_RECEIPT_CODES,
  warehouseBatchSchema,
  warehouseLookupResultSchema,
  warehouseLookupSchema,
} from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("the warehouse reprint on the wire (plan СКЛ)", () => {
  it("reads every fixture as the host writes it", () => {
    for (const name of ["warehouse-lookup-code.json", "warehouse-lookup-sscc.json"]) {
      expect(warehouseLookupSchema.parse(fixture(name)), name).toEqual(fixture(name));
    }
    for (const name of [
      "warehouse-lookup-found-unit.json",
      "warehouse-lookup-found-pallet.json",
      "warehouse-lookup-not-found.json",
      "warehouse-lookup-unavailable.json",
    ]) {
      expect(warehouseLookupResultSchema.parse(fixture(name)), name).toEqual(fixture(name));
    }
    expect(warehouseBatchSchema.parse(fixture("warehouse-records-request.json"))).toEqual(
      fixture("warehouse-records-request.json"),
    );
    expect(factReceiptsSchema.parse(fixture("warehouse-records-response.json"))).toEqual(
      fixture("warehouse-records-response.json"),
    );
  });

  it("asks one thing at a time, and nothing the host does not know", () => {
    expect(warehouseLookupSchema.safeParse({}).success).toBe(false);
    expect(
      warehouseLookupSchema.safeParse({ codeHash: "a".repeat(64), sscc: "046006820000015000" })
        .success,
    ).toBe(false);
    expect(warehouseLookupSchema.safeParse({ raw: "x" }).success).toBe(false);
  });

  it("keeps the full code of a unit with its separator", () => {
    const found = warehouseLookupResultSchema.parse(fixture("warehouse-lookup-found-unit.json"));
    if (found.status !== "found") throw new Error("the fixture is found");
    expect(found.source.canonical).toBe("010460068200001321S000001\u001d93Tail");
  });

  it("knows the host's receipt codes, reasons and outcomes", () => {
    expect(fixture("warehouse-receipt-codes.json")).toEqual({
      codes: [...WAREHOUSE_RECEIPT_CODES],
    });
    expect([...WAREHOUSE_REASONS]).toEqual(["not_printed", "damaged", "lost"]);
    expect([...WAREHOUSE_OUTCOMES]).toEqual(["sent", "unknown", "failed", "verified", "cancelled"]);
  });

  it("refuses a record with a field the host would refuse to read", () => {
    const batch = fixture("warehouse-records-request.json") as { records: object[] };
    const [first] = batch.records;
    expect(warehouseBatchSchema.safeParse({ records: [] }).success).toBe(false);
    expect(warehouseBatchSchema.safeParse({ records: [{ ...first, addedLater: 1 }] }).success).toBe(
      false,
    );
    expect(warehouseBatchSchema.safeParse({ records: [{ ...first, reasonCode: "x" }] }).success).toBe(
      false,
    );
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-protocol.test.ts` — FAIL (схемы не экспортированы).

- [ ] **Шаг 5: Zod.** В `apps/standalone/src/host/protocol.ts` найти:

<!-- prettier-ignore -->
```ts
/** The answer of `POST /v1/device/facts`: a receipt per record, in the records' order. */
export const factReceiptsSchema = z.object({ receipts: z.array(factReceiptSchema) });
```

и заменить на:

<!-- prettier-ignore -->
```ts
/** The answer of `POST /v1/device/facts`: a receipt per record, in the records' order. */
export const factReceiptsSchema = z.object({ receipts: z.array(factReceiptSchema) });

// --- Warehouse label reprint (plan СКЛ) ---

/**
 * What `POST /v1/device/warehouse/lookup` asks (`markiro_proto::WarehouseLookup`):
 * the hash of a unit's code (`kmHash`) or the SSCC of a box or a pallet, one of the two.
 */
export const warehouseLookupSchema = z.union([
  z.object({ codeHash: z.string() }).strict(),
  z.object({ sscc: z.string() }).strict(),
]);
export type WarehouseLookup = z.infer<typeof warehouseLookupSchema>;

/** What a warehouse reprint prints (`markiro_proto::WarehouseSubjectKind`). */
export const WAREHOUSE_SUBJECT_KINDS = ["unit", "box", "pallet"] as const;
export type WarehouseSubjectKind = (typeof WAREHOUSE_SUBJECT_KINDS)[number];

/**
 * A record the host found (`markiro_proto::WarehouseSource`): what its label is
 * rendered from, the full canonical code of a unit, the SSCC of a box or a pallet.
 */
export const warehouseSourceSchema = z.object({
  kind: z.enum(WAREHOUSE_SUBJECT_KINDS),
  subjectId: z.string().min(1),
  identity: z.string().min(1),
  canonical: z.string().optional(),
  sscc: z.string().optional(),
  product: shiftSnapshotProductSchema,
  counterpartyName: z.string().nullable(),
  shiftId: z.uuid(),
  shiftNumber: z.string(),
  productionDate: z.string(),
  at: z.string(),
  itemCount: z.number().int().nonnegative(),
  boxCount: z.number().int().nonnegative().optional(),
  operatorName: z.string().nullable(),
  deviceId: z.uuid(),
});
export type WarehouseSource = z.infer<typeof warehouseSourceSchema>;

/** Why a found record is not printed again (`markiro_proto::WarehouseUnavailable`). */
export const WAREHOUSE_UNAVAILABLE = ["released", "disassembled"] as const;

/** The answer of `POST /v1/device/warehouse/lookup`. */
export const warehouseLookupResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), source: warehouseSourceSchema }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("unavailable"), reason: z.enum(WAREHOUSE_UNAVAILABLE) }),
]);
export type WarehouseLookupResult = z.infer<typeof warehouseLookupResultSchema>;

/** `markiro_proto::WAREHOUSE_REASONS`: why a label is printed again. */
export const WAREHOUSE_REASONS = ["not_printed", "damaged", "lost"] as const;
/** `markiro_proto::WAREHOUSE_OUTCOMES`: where one attempt ended. */
export const WAREHOUSE_OUTCOMES = ["sent", "unknown", "failed", "verified", "cancelled"] as const;
/** `markiro_proto::warehouse_receipt_codes` (`proto/fixtures/warehouse-receipt-codes.json`). */
export const WAREHOUSE_RECEIPT_CODES = ["invalid_record", "payload_mismatch", "subject_unknown"] as const;

/** One attempt of a reprint as recorded (`markiro_proto::WarehouseRecord`). */
export const warehouseRecordSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    jobId: z.uuid(),
    attempt: z.number().int().nonnegative(),
    subjectKind: z.enum(WAREHOUSE_SUBJECT_KINDS),
    subjectId: z.string().min(1),
    identity: z.string().min(1),
    reasonCode: z.enum(WAREHOUSE_REASONS),
    repair: z.literal("legacy_tspl_fnc1_literal").nullable(),
    templateId: z.string().min(1),
    templateRev: z.number().int().nonnegative(),
    outcome: z.enum(WAREHOUSE_OUTCOMES),
    errorCode: z.string().nullable(),
    operatorId: z.uuid().nullable(),
    occurredAt: z.string(),
  })
  .strict();
export type WarehouseRecord = z.infer<typeof warehouseRecordSchema>;

/** `POST /v1/device/warehouse/reprints`; the answer is `factReceiptsSchema`. */
export const warehouseBatchSchema = z
  .object({ records: z.array(warehouseRecordSchema).min(1).max(100) })
  .strict();
```

- [ ] **Шаг 6: `HostApi`.** В `apps/standalone/src/host/api.ts`:

Найти `  templateDefaultsSchema,\n  type BadgeCreate,` и заменить на:

<!-- prettier-ignore -->
```ts
  templateDefaultsSchema,
  warehouseLookupResultSchema,
  type BadgeCreate,
```

Найти `  type TemplateUpdate,\n} from "./protocol.js";` и заменить на:

<!-- prettier-ignore -->
```ts
  type TemplateUpdate,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "./protocol.js";
```

Найти (объявление в интерфейсе):

<!-- prettier-ignore -->
```ts
  checkCode: (codeHash: string) => Promise<CodeCheck>;
```

и заменить на:

<!-- prettier-ignore -->
```ts
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /**
   * What a label is printed again from (plan СКЛ): a unit by its code's hash,
   * a box or a pallet by its SSCC, of any station and any shift of this site.
   * The full code comes only in the answer's body.
   */
  warehouseLookup: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  /** The warehouse reprint records (1–100); a receipt per record, in their order. */
  sendWarehouseRecords: (records: readonly unknown[]) => Promise<FactReceipt[]>;
```

Найти (реализация):

<!-- prettier-ignore -->
```ts
    checkCode: (codeHash) =>
      client.request("GET", `/v1/device/codes/${encodeURIComponent(codeHash)}`, {
        timeoutMs: CODE_CHECK_TIMEOUT_MS,
        schema: codeCheckSchema,
      }),
```

и заменить на:

<!-- prettier-ignore -->
```ts
    checkCode: (codeHash) =>
      client.request("GET", `/v1/device/codes/${encodeURIComponent(codeHash)}`, {
        timeoutMs: CODE_CHECK_TIMEOUT_MS,
        schema: codeCheckSchema,
      }),
    warehouseLookup: (lookup) =>
      client.request("POST", "/v1/device/warehouse/lookup", {
        body: lookup,
        schema: warehouseLookupResultSchema,
      }),
    sendWarehouseRecords: async (records) =>
      (
        await client.request("POST", "/v1/device/warehouse/reprints", {
          body: { records },
          schema: factReceiptsSchema,
        })
      ).receipts,
```

В `apps/standalone/test/support/office.tsx` найти:

<!-- prettier-ignore -->
```ts
    sendFacts: vi.fn<HostApi["sendFacts"]>(() => unexpected("sendFacts")),
```

и заменить на:

<!-- prettier-ignore -->
```ts
    sendFacts: vi.fn<HostApi["sendFacts"]>(() => unexpected("sendFacts")),
    warehouseLookup: vi.fn<HostApi["warehouseLookup"]>(() => unexpected("warehouseLookup")),
    sendWarehouseRecords: vi.fn<HostApi["sendWarehouseRecords"]>(() =>
      unexpected("sendWarehouseRecords"),
    ),
```

В `apps/standalone/test/api.test.ts` найти:

<!-- prettier-ignore -->
```ts
  it("limits the code check's request and no other", async () => {
```

и вставить перед ним:

<!-- prettier-ignore -->
```ts
  it("looks a label up and sends the warehouse records in the body, with the device key only", async () => {
    const lookup = recording(fixture("warehouse-lookup-found-unit.json"));
    await expect(
      lookup.api.warehouseLookup({ sscc: "046006820000015000" }),
    ).resolves.toEqual(fixture("warehouse-lookup-found-unit.json"));
    const records = (fixture("warehouse-records-request.json") as { records: unknown[] }).records;
    const sent = recording(fixture("warehouse-records-response.json"));
    await expect(sent.api.sendWarehouseRecords(records)).resolves.toEqual(
      (fixture("warehouse-records-response.json") as { receipts: unknown[] }).receipts,
    );
    expect([...lookup.sent, ...sent.sent]).toEqual([
      {
        method: "POST",
        path: "/v1/device/warehouse/lookup",
        body: { sscc: "046006820000015000" },
        officeToken: undefined,
      },
      {
        method: "POST",
        path: "/v1/device/warehouse/reprints",
        body: { records },
        officeToken: undefined,
      },
    ]);
  });

```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-protocol.test.ts test/api.test.ts` — PASS; `typecheck`, `lint` — чисто.

- [ ] **Шаг 7: коммит.**

```
git add apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/warehouse.rs apps/standalone/proto/fixtures/warehouse-lookup-code.json apps/standalone/proto/fixtures/warehouse-lookup-sscc.json apps/standalone/proto/fixtures/warehouse-lookup-found-unit.json apps/standalone/proto/fixtures/warehouse-lookup-found-pallet.json apps/standalone/proto/fixtures/warehouse-lookup-not-found.json apps/standalone/proto/fixtures/warehouse-lookup-unavailable.json apps/standalone/proto/fixtures/warehouse-records-request.json apps/standalone/proto/fixtures/warehouse-records-response.json apps/standalone/proto/fixtures/warehouse-receipt-codes.json apps/standalone/src/host/protocol.ts apps/standalone/src/host/api.ts apps/standalone/test/warehouse-protocol.test.ts apps/standalone/test/support/office.tsx apps/standalone/test/api.test.ts
```

Сообщение: `feat(standalone): warehouse reprint wire types and fixtures (plan СКЛ task 1)` + трейлер.

---

## Задача 2: хост — поиск записи для перепечатки

**Files:**

- Create: `apps/standalone/host/src/routes/warehouse.rs` (функция `lookup`; задача 3 дописывает записи)
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`
- Create: `apps/standalone/host/tests/warehouse.rs`

**Interfaces:** `routes::warehouse::lookup(State, AuthDevice, ApiJson<WarehouseLookup>) -> Result<Json<WarehouseLookupResult>, ApiError>`; константы `UNIT_SQL`, `UNIT_SEEN_SQL`, `BOX_SQL`, `PALLET_SQL`; путь `/v1/device/warehouse/lookup`; `held_by_a_restore` держит всё `/v1/device/warehouse/`.

- [ ] **Шаг 1: тест (RED).** Создать `apps/standalone/host/tests/warehouse.rs`:

<!-- prettier-ignore -->
```rust
//! Warehouse label reprint (plan СКЛ): any station looks up a unit, a box or
//! a pallet of any station and any shift of the site, and keeps its records
//! of what it printed.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, add_operator, admin, box_closed, box_id, code, code_hash, fact, instant,
    issue_block, issue_pallet_block, json as json_request, ok_scan, open_floor,
    open_pallet_floor, pair_device, pallet_closed, pallet_id, pallet_sscc, receipts, record_id,
    request, shift_closed, shift_setup, sscc, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

/// `POST path` with `key` and `body`: the status and the body.
async fn post(admin: &Admin, key: &str, path: &str, body: Value) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(with_device(request("POST", path), key), body))
        .await
}

async fn lookup(admin: &Admin, key: &str, body: Value) -> (StatusCode, Value) {
    post(admin, key, "/v1/device/warehouse/lookup", body).await
}

/// A record `n` of `kind` in the floor's shift, by `operator`.
fn by(floor: &Floor, n: u32, kind: &str, data: Value, operator: &str) -> Value {
    let mut record = fact(&record_id(n), kind, &floor.shift, data);
    record["operatorId"] = json!(operator);
    record
}

/// A host whose first station scanned code 1 into box 1 and closed it with
/// serial 1500 (by Anna), and then closed its shift; and a second station,
/// which asks. Returns the host, the floor, the asking key and Anna's id.
async fn closed_shift_with_a_box() -> (Admin, Floor, String, String) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (anna, _) = add_operator(&admin, "0042").await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let records = [
        by(&floor, 1, "scan", ok_scan(1, &box_id(1), &instant(1, 0)), &anna),
        by(
            &floor,
            2,
            "box_closed",
            box_closed(&box_id(1), &block, 1500, &[1], &instant(1, 0), &instant(2, 0)),
            &anna,
        ),
        by(
            &floor,
            3,
            "shift_closed",
            shift_closed(None, 1, 1, None, &instant(10, 0)),
            &anna,
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &records).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
    let (_, asking) = pair_device(&admin.app, "station").await;
    (admin, floor, asking, anna)
}

fn product(admin_product: &str) -> Value {
    json!({
        "id": admin_product, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
        "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "shelfLifeDays": 10
    })
}

#[tokio::test]
async fn a_unit_of_another_station_in_a_closed_shift_is_found_with_its_full_code() {
    let (admin, floor, asking, _) = closed_shift_with_a_box().await;
    let (status, body) = lookup(&admin, &asking, json!({ "codeHash": code_hash(1) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "found");
    let source = &body["source"];
    assert_eq!(source["kind"], "unit");
    assert_eq!(source["identity"], code_hash(1));
    assert_eq!(source["canonical"], code(1)["canonical"]);
    assert!(source.get("sscc").is_none());
    assert_eq!(source["shiftId"], floor.shift);
    assert_eq!(source["shiftNumber"], floor.number);
    assert_eq!(source["productionDate"], "2026-10-08");
    assert_eq!(source["at"], instant(1, 0));
    assert_eq!(source["itemCount"], 1);
    assert_eq!(source["operatorName"], "Анна Кузнецова");
    assert_eq!(source["deviceId"], floor.station);
    assert_eq!(source["counterpartyName"], Value::Null);
    assert_eq!(source["product"], product(source["product"]["id"].as_str().unwrap()));
    // The record the scan wrote is what a reprint record names.
    assert!(source["subjectId"].as_str().is_some_and(|id| !id.is_empty()));
}

#[tokio::test]
async fn a_box_is_found_by_its_sscc_with_the_count_it_was_closed_with() {
    let (admin, floor, asking, _) = closed_shift_with_a_box().await;
    let (status, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let source = &body["source"];
    assert_eq!(
        (&source["kind"], &source["subjectId"], &source["sscc"], &source["identity"]),
        (&json!("box"), &json!(box_id(1)), &json!(sscc(1500)), &json!(sscc(1500)))
    );
    assert_eq!(source["at"], instant(2, 0));
    assert_eq!(source["itemCount"], 1);
    assert!(source.get("canonical").is_none());
    assert!(source.get("boxCount").is_none());
    assert_eq!(source["shiftNumber"], floor.number);
}

#[tokio::test]
async fn a_pallet_is_found_by_its_sscc_with_its_boxes_and_their_units() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let mut closed = box_closed(&box_id(1), &block, 1500, &[1], &instant(1, 0), &instant(2, 0));
    closed["palletId"] = json!(pallet_id(1));
    let records = [
        fact(&record_id(1), "scan", &floor.shift, ok_scan(1, &box_id(1), &instant(1, 0))),
        fact(&record_id(2), "box_closed", &floor.shift, closed),
        fact(
            &record_id(3),
            "pallet_closed",
            &floor.shift,
            pallet_closed(&pallet_id(1), &pallets, 40, 1, &instant(2, 0), &instant(3, 0)),
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(answered.iter().all(|receipt| receipt["outcome"] == "accepted"), "{answered:?}");
    let (status, body) = lookup(&admin, &floor.key, json!({ "sscc": pallet_sscc(40) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let source = &body["source"];
    assert_eq!(source["kind"], "pallet");
    assert_eq!(source["subjectId"], pallet_id(1));
    assert_eq!(source["sscc"], pallet_sscc(40));
    assert_eq!((&source["boxCount"], &source["itemCount"]), (&json!(1), &json!(1)));
    assert_eq!(source["at"], instant(3, 0));
    assert_eq!(source["operatorName"], Value::Null);
}

#[tokio::test]
async fn a_freed_code_and_a_box_taken_apart_are_unavailable_and_an_unknown_one_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let records = [
        fact(&record_id(1), "scan", &floor.shift, ok_scan(1, &box_id(1), &instant(1, 0))),
        fact(
            &record_id(2),
            "box_closed",
            &floor.shift,
            box_closed(&box_id(1), &block, 1500, &[1], &instant(1, 0), &instant(2, 0)),
        ),
        fact(
            &record_id(3),
            "box_exception",
            &floor.shift,
            json!({
                "exception": "disassemble", "boxId": box_id(1), "codeHash": null,
                "targetScannedAt": null, "reasonCode": "wrong_product", "reasonText": null,
                "occurredAt": instant(5, 0)
            }),
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(answered.iter().all(|receipt| receipt["outcome"] == "accepted"), "{answered:?}");
    let key = floor.key.clone();
    assert_eq!(
        lookup(&admin, &key, json!({ "sscc": sscc(1500) })).await,
        (StatusCode::OK, json!({ "status": "unavailable", "reason": "disassembled" }))
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": code_hash(1) })).await,
        (StatusCode::OK, json!({ "status": "unavailable", "reason": "released" }))
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": code_hash(99) })).await,
        (StatusCode::OK, json!({ "status": "not_found" }))
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "sscc": sscc(2000) })).await,
        (StatusCode::OK, json!({ "status": "not_found" }))
    );
}

#[tokio::test]
async fn a_lookup_asks_exactly_one_well_formed_thing_with_a_live_key() {
    let admin = admin().await;
    let key = admin.key.clone();
    for (body, field) in [
        (json!({}), "codeHash"),
        (json!({ "codeHash": code_hash(1), "sscc": sscc(1500) }), "codeHash"),
        (json!({ "codeHash": "ABC" }), "codeHash"),
        (json!({ "sscc": "12345" }), "sscc"),
        (json!({ "sscc": "04600682000001500a" }), "sscc"),
    ] {
        let (status, answer) = lookup(&admin, &key, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{body}");
        assert_eq!(answer["error"]["details"]["field"], field, "{body}");
    }
    let (status, _) = lookup(&admin, &key, json!({ "raw": "010460068200001321S000001" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, answer) = lookup(&admin, "not-a-key", json!({ "sscc": sscc(1500) })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{answer}");
}

#[tokio::test]
async fn a_restore_holds_the_warehouse_routes() {
    let admin = admin().await;
    sqlx::query("UPDATE site SET facts_held_since = '2026-10-09T15:00:00Z' WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let key = admin.key.clone();
    for path in ["/v1/device/warehouse/lookup", "/v1/device/warehouse/reprints"] {
        let (status, body) = post(&admin, &key, path, json!({ "sscc": sscc(1500) })).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
        assert_eq!(body["error"]["code"], "restore_pending", "{path}");
    }
}
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test warehouse` — FAIL (`404`/маршрута нет; ошибки компиляции нет — тест обращается по HTTP).

- [ ] **Шаг 2: маршрут.** Создать `apps/standalone/host/src/routes/warehouse.rs`:

<!-- prettier-ignore -->
```rust
//! Warehouse label reprint (plan СКЛ, pilot spec §30). A station finds a
//! unit's code, a box or a pallet of any station and any shift of the site
//! — closed ones too — and prints its label again on a template it chose,
//! without making a new code, box or SSCC.
//!
//! `POST /v1/device/warehouse/lookup` answers what a label is rendered from:
//! the product and the counterparty as the shift froze them, the shift's
//! number and production date, the instant the label dates from (a unit's
//! scan, a box's or a pallet's close), the counts it was printed with, the
//! operator's name and, for a unit, its full canonical code. It reads in one
//! snapshot outside any write transaction and writes nothing but the
//! device's `last_seen_at` (`AuthDevice`). The full code goes only into the
//! answer's body: nothing here logs it, and an error names no value.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    ShiftOrigin, ShiftSnapshot, ShiftSnapshotProduct, WarehouseLookup, WarehouseLookupResult,
    WarehouseSource, WarehouseSubjectKind, WarehouseUnavailable,
};
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::error::{ApiError, ApiJson};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;

/// The scan that owns a code now (`code_owners`), with its operator's name.
pub const UNIT_SQL: &str = "SELECT s.id, s.canonical, s.scanned_at, op.name, s.device_id, \
     s.shift_id FROM code_owners o JOIN scans s ON s.id = o.scan_id \
     LEFT JOIN operators op ON op.id = s.operator_id WHERE o.code_hash = ?";

/// Whether an accepted scan ever had the code: a code without an owner was
/// freed by an exception.
pub const UNIT_SEEN_SQL: &str =
    "SELECT 1 FROM scans WHERE code_hash = ? AND verdict = 'ok' LIMIT 1";

/// A closed box by its SSCC, with the count it was closed (and printed) with.
pub const BOX_SQL: &str = "SELECT b.id, b.closed_at, COALESCE(b.item_count_reported, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id AND i.removed_at IS NULL \
     AND i.displaced_at IS NULL)), b.disassembled_at, op.name, b.device_id, b.shift_id \
     FROM boxes b LEFT JOIN operators op ON op.id = b.operator_id WHERE b.sscc = ?";

/// A closed pallet by its SSCC: the boxes it was closed with, the units of
/// its boxes not taken apart now.
pub const PALLET_SQL: &str = "SELECT p.id, p.closed_at, p.box_count_reported, \
     (SELECT COALESCE(SUM(b.item_count_reported), 0) FROM boxes b WHERE b.pallet_id = p.id \
     AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL), p.disassembled_at, op.name, \
     p.device_id, p.shift_id FROM pallets p LEFT JOIN operators op ON op.id = p.operator_id \
     WHERE p.sscc = ?";

/// The shift a record belongs to: its frozen snapshot, date and number.
const SHIFT_SQL: &str = "SELECT snapshot, production_date, number_month_key, number_seq, \
     created_from FROM shifts WHERE id = ?";

/// What a shift gives every label of it.
struct ShiftPart {
    product: ShiftSnapshotProduct,
    counterparty_name: Option<String>,
    shift_number: String,
    production_date: String,
}

async fn shift_part(conn: &mut SqliteConnection, shift_id: &str) -> Result<ShiftPart, ApiError> {
    type ShiftRow = (Option<String>, String, String, i64, String);
    let (snapshot, production_date, month_key, seq, created_from): ShiftRow =
        sqlx::query_as(SHIFT_SQL)
            .bind(shift_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    // A shift a fact names was entered, and entering froze its snapshot.
    let text = snapshot.ok_or_else(|| ApiError::internal("a shift with facts has no snapshot"))?;
    let snapshot: ShiftSnapshot = serde_json::from_str(&text).map_err(ApiError::internal)?;
    let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
    Ok(ShiftPart {
        product: snapshot.product,
        counterparty_name: snapshot.counterparty_name,
        shift_number: shifts::format_number(&month_key, seq, origin),
        production_date,
    })
}

/// 18 ASCII digits; the check digit is the station's business.
pub fn is_sscc(text: &str) -> bool {
    text.len() == 18 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// What a lookup asks, once its form is checked.
enum Asked<'a> {
    Code(&'a str),
    Sscc(&'a str),
}

/// `POST /v1/device/warehouse/lookup`: any device of the site; exactly one
/// of `codeHash` (64 lower-case hex digits) and `sscc` (18 digits),
/// `validation_failed` otherwise.
pub async fn lookup(
    State(state): State<AppState>,
    _device: AuthDevice,
    ApiJson(what): ApiJson<WarehouseLookup>,
) -> Result<Json<WarehouseLookupResult>, ApiError> {
    let asked = match (what.code_hash.as_deref(), what.sscc.as_deref()) {
        (Some(code_hash), None) if rules::is_code_hash(code_hash) => Asked::Code(code_hash),
        (Some(_), None) => {
            return Err(ApiError::validation(
                "codeHash",
                "64 lower-case hex digits are required",
            ))
        }
        (None, Some(sscc)) if is_sscc(sscc) => Asked::Sscc(sscc),
        (None, Some(_)) => return Err(ApiError::validation("sscc", "18 digits are required")),
        _ => {
            return Err(ApiError::validation(
                "codeHash",
                "exactly one of codeHash and sscc is required",
            ))
        }
    };
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let found = match asked {
        Asked::Code(code_hash) => find_unit(&mut tx, code_hash).await,
        Asked::Sscc(sscc) => find_sscc(&mut tx, sscc).await,
    };
    tx.rollback().await.map_err(ApiError::internal)?;
    found.map(Json)
}

async fn find_unit(
    conn: &mut SqliteConnection,
    code_hash: &str,
) -> Result<WarehouseLookupResult, ApiError> {
    type UnitRow = (String, Option<String>, String, Option<String>, String, String);
    let row: Option<UnitRow> = sqlx::query_as(UNIT_SQL)
        .bind(code_hash)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((scan_id, canonical, scanned_at, operator_name, device_id, shift_id)) = row else {
        let seen: Option<i64> = sqlx::query_scalar(UNIT_SEEN_SQL)
            .bind(code_hash)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        return Ok(match seen {
            Some(_) => WarehouseLookupResult::Unavailable {
                reason: WarehouseUnavailable::Released,
            },
            None => WarehouseLookupResult::NotFound,
        });
    };
    let shift = shift_part(conn, &shift_id).await?;
    Ok(WarehouseLookupResult::Found {
        source: WarehouseSource {
            kind: WarehouseSubjectKind::Unit,
            subject_id: scan_id,
            identity: code_hash.to_owned(),
            canonical,
            sscc: None,
            product: shift.product,
            counterparty_name: shift.counterparty_name,
            shift_id,
            shift_number: shift.shift_number,
            production_date: shift.production_date,
            at: scanned_at,
            item_count: 1,
            box_count: None,
            operator_name,
            device_id,
        },
    })
}

async fn find_sscc(
    conn: &mut SqliteConnection,
    sscc: &str,
) -> Result<WarehouseLookupResult, ApiError> {
    type BoxRow = (
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let found: Option<BoxRow> = sqlx::query_as(BOX_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some((id, closed_at, items, disassembled_at, operator_name, device_id, shift_id)) =
        found
    {
        if disassembled_at.is_some() {
            return Ok(WarehouseLookupResult::Unavailable {
                reason: WarehouseUnavailable::Disassembled,
            });
        }
        let at = closed_at.ok_or_else(|| ApiError::internal("a box with an SSCC is not closed"))?;
        let shift = shift_part(conn, &shift_id).await?;
        return Ok(WarehouseLookupResult::Found {
            source: WarehouseSource {
                kind: WarehouseSubjectKind::Box,
                subject_id: id,
                identity: sscc.to_owned(),
                canonical: None,
                sscc: Some(sscc.to_owned()),
                product: shift.product,
                counterparty_name: shift.counterparty_name,
                shift_id,
                shift_number: shift.shift_number,
                production_date: shift.production_date,
                at,
                item_count: u32::try_from(items).map_err(ApiError::internal)?,
                box_count: None,
                operator_name,
                device_id,
            },
        });
    }
    type PalletRow = (
        String,
        Option<String>,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let found: Option<PalletRow> = sqlx::query_as(PALLET_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((id, closed_at, boxes, items, disassembled_at, operator_name, device_id, shift_id)) =
        found
    else {
        return Ok(WarehouseLookupResult::NotFound);
    };
    if disassembled_at.is_some() {
        return Ok(WarehouseLookupResult::Unavailable {
            reason: WarehouseUnavailable::Disassembled,
        });
    }
    let at = closed_at.ok_or_else(|| ApiError::internal("a pallet with an SSCC is not closed"))?;
    let shift = shift_part(conn, &shift_id).await?;
    Ok(WarehouseLookupResult::Found {
        source: WarehouseSource {
            kind: WarehouseSubjectKind::Pallet,
            subject_id: id,
            identity: sscc.to_owned(),
            canonical: None,
            sscc: Some(sscc.to_owned()),
            product: shift.product,
            counterparty_name: shift.counterparty_name,
            shift_id,
            shift_number: shift.shift_number,
            production_date: shift.production_date,
            at,
            item_count: u32::try_from(items).map_err(ApiError::internal)?,
            box_count: Some(u32::try_from(boxes.unwrap_or(0)).map_err(ApiError::internal)?),
            operator_name,
            device_id,
        },
    })
}
```

В `apps/standalone/host/src/routes/mod.rs` найти `pub mod templates;` и заменить на:

<!-- prettier-ignore -->
```rust
pub mod templates;
pub mod warehouse;
```

В `apps/standalone/host/src/server.rs` найти:

<!-- prettier-ignore -->
```rust
fn held_by_a_restore(path: &str) -> bool {
    path == "/v1/device/facts" || path.starts_with("/v1/device/codes/")
}
```

и заменить на:

<!-- prettier-ignore -->
```rust
fn held_by_a_restore(path: &str) -> bool {
    path == "/v1/device/facts"
        || path.starts_with("/v1/device/codes/")
        // A reprint looks up and records against shifts, boxes and codes a
        // copy may lack (plan СКЛ).
        || path.starts_with("/v1/device/warehouse/")
}
```

Найти:

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/codes/{code_hash}",
            get(crate::routes::codes::check_code),
        )
```

и заменить на:

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/codes/{code_hash}",
            get(crate::routes::codes::check_code),
        )
        .route(
            "/v1/device/warehouse/lookup",
            post(crate::routes::warehouse::lookup),
        )
```

Комментарий к `RESTORE_RETRY_AFTER_SECS`/`held_by_a_restore` («a station's facts and its code checks») дописать: «and its warehouse reprints».

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test warehouse` — PASS для пяти тестов поиска; `a_restore_holds_the_warehouse_routes` уже PASS (держит слой над роутером, даже для маршрута записей, которого ещё нет). Затем `cargo test ... -p markiro-host --test restore_hold --test codes` — PASS (не сломаны).

- [ ] **Шаг 3: мутация.** `cp apps/standalone/host/src/routes/warehouse.rs /tmp/claude/before`; в `find_sscc` убрать `if disassembled_at.is_some() { … }` у короба; команда шага 2 — FAIL `a_freed_code_and_a_box_taken_apart_are_unavailable_and_an_unknown_one_not_found`; вернуть (`cp /tmp/claude/before …`, `cmp` молчит).

- [ ] **Шаг 4: коммит.** `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git add apps/standalone/host/src/routes/warehouse.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/warehouse.rs`; сообщение `feat(standalone): host warehouse lookup by code hash or SSCC (plan СКЛ task 2)` + трейлер.

---

## Задача 3: хост — записи перепечатки (миграция `0015`)

**Files:**

- Create: `apps/standalone/host/migrations/0015_warehouse_reprints.sql`
- Modify: `apps/standalone/host/src/routes/warehouse.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/warehouse.rs`

**Interfaces:** `routes::warehouse::receive_records(State, AuthDevice, ApiJson<IncomingRecords>) -> Result<Json<FactReceipts>, ApiError>`; `MAX_RECORDS = 100`; таблица `warehouse_reprints` с ключом `(device_id, record_id)`; путь `/v1/device/warehouse/reprints`.

- [ ] **Шаг 1: тест (RED).** В `apps/standalone/host/tests/warehouse.rs` дописать в конец:

<!-- prettier-ignore -->
```rust
const SESSION: &str = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const JOB: &str = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";

/// Record `n` of a reprint of `subject_id`/`identity` of `kind`, sent.
fn reprint(n: u32, kind: &str, subject_id: &str, identity: &str) -> Value {
    json!({
        "id": record_id(n), "sessionId": SESSION, "jobId": JOB, "attempt": 1,
        "subjectKind": kind, "subjectId": subject_id, "identity": identity,
        "reasonCode": "damaged", "repair": null, "templateId": "template-1", "templateRev": 3,
        "outcome": "sent", "errorCode": null, "operatorId": null, "occurredAt": instant(20, 0)
    })
}

async fn send_records(admin: &Admin, key: &str, records: &[Value]) -> Vec<Value> {
    let (status, body) = post(
        admin,
        key,
        "/v1/device/warehouse/reprints",
        json!({ "records": records }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

async fn reprint_rows(admin: &Admin) -> Vec<(String, String, String, i64, Option<String>)> {
    sqlx::query_as(
        "SELECT record_id, subject_kind, outcome, attempt, error_code FROM warehouse_reprints \
         ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn records_are_kept_once_and_answered_like_facts() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let (_, unit) = lookup(&admin, &asking, json!({ "codeHash": code_hash(1) })).await;
    let scan = unit["source"]["subjectId"].as_str().unwrap().to_owned();
    let mut unknown = reprint(2, "unit", &scan, &code_hash(1));
    unknown["outcome"] = json!("unknown");
    unknown["errorCode"] = json!("timeout");
    unknown["attempt"] = json!(2);
    let first = [reprint(1, "box", &box_id(1), &sscc(1500)), unknown.clone()];
    assert_eq!(
        send_records(&admin, &asking, &first).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    // The same records again: the same receipts, nothing written twice.
    assert_eq!(
        send_records(&admin, &asking, &first).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    assert_eq!(
        reprint_rows(&admin).await,
        vec![
            (record_id(1), "box".into(), "sent".into(), 1, None),
            (record_id(2), "unit".into(), "unknown".into(), 2, Some("timeout".into())),
        ]
    );
    // Other content under a kept id; a subject the host does not have; a
    // record it cannot read, with and without a readable id.
    let mut changed = reprint(1, "box", &box_id(1), &sscc(1500));
    changed["reasonCode"] = json!("lost");
    let mut foreign = reprint(3, "box", &box_id(7), &sscc(1500));
    foreign["subjectId"] = json!(box_id(7));
    let mut broken = reprint(4, "box", &box_id(1), &sscc(1500));
    broken["outcome"] = json!("failed");
    assert_eq!(
        send_records(&admin, &asking, &[changed, foreign, broken, json!({ "id": 5 })]).await,
        vec![
            json!({ "id": record_id(1), "outcome": "rejected", "code": "payload_mismatch" }),
            json!({ "id": record_id(3), "outcome": "rejected", "code": "subject_unknown" }),
            json!({ "id": record_id(4), "outcome": "rejected", "code": "invalid_record" }),
            json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }),
        ]
    );
    assert_eq!(reprint_rows(&admin).await.len(), 2);
    // A reprint changes nothing of what it printed.
    let (verified, skipped): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT print_verified_at, print_skipped_at FROM boxes WHERE id = ?",
    )
    .bind(box_id(1))
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!((verified, skipped), (None, None));
}

#[tokio::test]
async fn each_field_of_a_record_keeps_its_rule() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let good = reprint(1, "box", &box_id(1), &sscc(1500));
    let bad: Vec<(&str, Value)> = vec![
        ("id", json!("not-a-uuid")),
        ("sessionId", json!("X")),
        ("attempt", json!(-1)),
        ("subjectKind", json!("crate")),
        ("subjectId", json!("")),
        ("identity", json!("12345")),
        ("reasonCode", json!("other")),
        ("repair", json!("trim")),
        ("templateRev", json!(-1)),
        ("outcome", json!("printed")),
        ("errorCode", json!("timeout")),
        ("operatorId", json!("anna")),
        ("occurredAt", json!("2026-10-08T06:00:20Z")),
    ];
    let mut records = Vec::new();
    for (n, (field, value)) in bad.iter().enumerate() {
        let mut record = good.clone();
        record["id"] = json!(record_id(100 + u32::try_from(n).unwrap()));
        record[*field] = value.clone();
        records.push(record);
    }
    let answered = send_records(&admin, &asking, &records).await;
    for (receipt, (field, _)) in answered.iter().zip(&bad) {
        assert_eq!(receipt["code"], "invalid_record", "{field}: {receipt}");
    }
    // A legacy repair only on a box or a pallet; a unit with one is refused.
    let mut unit = reprint(200, "unit", "scan-1", &code_hash(1));
    unit["repair"] = json!("legacy_tspl_fnc1_literal");
    assert_eq!(
        send_records(&admin, &asking, &[unit]).await[0]["code"],
        "invalid_record"
    );
    let (status, body) = post(
        &admin,
        &asking,
        "/v1/device/warehouse/reprints",
        json!({ "records": [] }),
    )
    .await;
    assert_eq!((status, &body["error"]["details"]["field"]), (StatusCode::BAD_REQUEST, &json!("records")));
    assert!(reprint_rows(&admin).await.is_empty());
}
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test warehouse` — FAIL два новых теста (`404`).

- [ ] **Шаг 2: миграция.** Создать `apps/standalone/host/migrations/0015_warehouse_reprints.sql`:

<!-- prettier-ignore -->
```sql
-- Warehouse label reprint (plan СКЛ, pilot spec §30): what a station printed
-- again — a unit's code, a box's or a pallet's label of any station and any
-- shift — one row per attempt as the station recorded it. Like the facts,
-- these are production data: no revision, no audit row, and every value is
-- checked before it is written (`routes/warehouse.rs`); the CHECKs hold what
-- no row may break. A reprint changes nothing it printed: no box, pallet,
-- code or SSCC is written by it. `identity` is a code's hash or an SSCC,
-- never a full code. `occurred_at` is the device's instant, `received_at`
-- the host's.
CREATE TABLE warehouse_reprints (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('unit', 'box', 'pallet')),
  subject_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('not_printed', 'damaged', 'lost')),
  repair TEXT CHECK (repair IS NULL
    OR (repair = 'legacy_tspl_fnc1_literal' AND subject_kind <> 'unit')),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'unknown', 'failed', 'verified', 'cancelled')),
  error_code TEXT,
  operator_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id),
  CHECK ((error_code IS NOT NULL) = (outcome IN ('failed', 'unknown')))
);
-- The office's history of one label (a later plan) reads by what was printed.
CREATE INDEX warehouse_reprints_identity ON warehouse_reprints (identity);
```

- [ ] **Шаг 3: приём записей.** В `apps/standalone/host/src/routes/warehouse.rs`:

Найти верхний комментарий, абзац

<!-- prettier-ignore -->
```rust
//! device's `last_seen_at` (`AuthDevice`). The full code goes only into the
//! answer's body: nothing here logs it, and an error names no value.
```

и заменить на:

<!-- prettier-ignore -->
```rust
//! device's `last_seen_at` (`AuthDevice`). The full code goes only into the
//! answer's body: nothing here logs it, and an error names no value.
//!
//! `POST /v1/device/warehouse/reprints` keeps the station's records of what
//! it printed (migration `0015`): a batch of 1–100 records in one write
//! transaction, each read from its own JSON value, answered with a receipt
//! per record in their order, as the facts are. A record kept before with
//! the same digest gets `accepted` again and writes nothing; other content
//! under its id `payload_mismatch`; a record that breaks a field's rule
//! `invalid_record`; one whose unit, box or pallet the host does not have
//! (by id and identity together) `subject_unknown`. Refusals are not kept: a
//! batch sent again is answered by the same rules. A database error is no
//! receipt: the batch fails and the station sends it again.
```

Найти:

<!-- prettier-ignore -->
```rust
use axum::extract::State;
use axum::Json;
use markiro_proto::{
    ShiftOrigin, ShiftSnapshot, ShiftSnapshotProduct, WarehouseLookup, WarehouseLookupResult,
    WarehouseSource, WarehouseSubjectKind, WarehouseUnavailable,
};
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::error::{ApiError, ApiJson};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;
```

и заменить на:

<!-- prettier-ignore -->
```rust
use axum::extract::State;
use axum::Json;
use markiro_proto::{
    warehouse_receipt_codes, FactOutcome, FactReceipt, FactReceipts, ShiftOrigin, ShiftSnapshot,
    ShiftSnapshotProduct, WarehouseLookup, WarehouseLookupResult, WarehouseRecord,
    WarehouseSource, WarehouseSubjectKind, WarehouseUnavailable, WAREHOUSE_OUTCOMES,
    WAREHOUSE_REASONS,
};
use serde::Deserialize;
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;
use crate::validate;

/// The most records of one batch, as for facts.
pub const MAX_RECORDS: usize = 100;
/// The longest id or code a record names, in characters.
const MAX_TEXT_CHARS: usize = 64;
/// More attempts than any operator makes on one label.
const MAX_ATTEMPT: u32 = 10_000;
```

Дописать в конец файла:

<!-- prettier-ignore -->
```rust
/// The body as the host reads it: each record a JSON value of its own, so a
/// record it cannot read is answered `rejected` and the others are kept.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomingRecords {
    records: Vec<Value>,
}

/// `POST /v1/device/warehouse/reprints`: any live device; 1–100 records.
pub async fn receive_records(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(batch): ApiJson<IncomingRecords>,
) -> Result<Json<FactReceipts>, ApiError> {
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
        return Err(ApiError::validation(
            "records",
            format!("1-{MAX_RECORDS} records"),
        ));
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock records nothing.
    device.require_live_in(&mut tx).await?;
    let received_at = state.timestamp();
    let mut receipts = Vec::with_capacity(batch.records.len());
    for (position, record) in batch.records.iter().enumerate() {
        match receive(&mut tx, &device.id, record, &received_at).await {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                // Its place in the batch, never the record.
                tracing::error!(device = %device.id, position, "a warehouse batch failed");
                return Err(error);
            }
        }
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}

fn accepted(id: String) -> FactReceipt {
    FactReceipt {
        id: Some(id),
        outcome: FactOutcome::Accepted,
        code: None,
        details: None,
    }
}

fn rejected(id: Option<String>, code: &str) -> FactReceipt {
    FactReceipt {
        id,
        outcome: FactOutcome::Rejected,
        code: Some(code.to_owned()),
        details: None,
    }
}

fn is_uuid(text: &str) -> bool {
    validate::client_uuid("id", text).is_ok()
}

/// Trimmed text of 1–64 characters without a control character.
fn is_plain(text: &str) -> bool {
    (1..=MAX_TEXT_CHARS).contains(&text.chars().count())
        && text.trim() == text
        && !text.chars().any(char::is_control)
}

/// A code word as the station writes it: lower-case letters and `_`.
fn is_code_word(text: &str) -> bool {
    (1..=MAX_TEXT_CHARS).contains(&text.len())
        && text.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

/// Every field of a record within its rule.
fn readable(record: &WarehouseRecord) -> bool {
    let identity = match record.subject_kind {
        WarehouseSubjectKind::Unit => rules::is_code_hash(&record.identity),
        WarehouseSubjectKind::Box | WarehouseSubjectKind::Pallet => is_sscc(&record.identity),
    };
    let repair = match record.repair.as_deref() {
        None => true,
        Some(repair) => {
            repair == "legacy_tspl_fnc1_literal"
                && record.subject_kind != WarehouseSubjectKind::Unit
        }
    };
    let unsettled = record.outcome == "failed" || record.outcome == "unknown";
    let error = match record.error_code.as_deref() {
        None => !unsettled,
        Some(code) => unsettled && is_code_word(code),
    };
    is_uuid(&record.id)
        && is_uuid(&record.session_id)
        && is_uuid(&record.job_id)
        && record.attempt <= MAX_ATTEMPT
        && is_plain(&record.subject_id)
        && identity
        && WAREHOUSE_REASONS.contains(&record.reason_code.as_str())
        && repair
        && is_plain(&record.template_id)
        && record.template_rev >= 0
        && WAREHOUSE_OUTCOMES.contains(&record.outcome.as_str())
        && error
        && record.operator_id.as_deref().map_or(true, is_uuid)
        && rules::device_instant(&record.occurred_at).is_some()
}

/// Whether the host has the unit (its scan), the box or the pallet a record
/// names, by its id and identity together.
async fn subject_exists(
    conn: &mut SqliteConnection,
    record: &WarehouseRecord,
) -> Result<bool, ApiError> {
    let sql = match record.subject_kind {
        WarehouseSubjectKind::Unit => "SELECT 1 FROM scans WHERE id = ? AND code_hash = ?",
        WarehouseSubjectKind::Box => "SELECT 1 FROM boxes WHERE id = ? AND sscc = ?",
        WarehouseSubjectKind::Pallet => "SELECT 1 FROM pallets WHERE id = ? AND sscc = ?",
    };
    let found: Option<i64> = sqlx::query_scalar(sql)
        .bind(&record.subject_id)
        .bind(&record.identity)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(found.is_some())
}

async fn receive(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<FactReceipt, ApiError> {
    let readable_id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_uuid(id))
        .map(str::to_owned);
    let record = match serde_json::from_value::<WarehouseRecord>(value.clone()) {
        Ok(record) if readable(&record) => record,
        _ => {
            return Ok(rejected(
                readable_id,
                warehouse_receipt_codes::INVALID_RECORD,
            ))
        }
    };
    let digest = rules::record_digest(value);
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT digest FROM warehouse_reprints WHERE device_id = ? AND record_id = ?",
    )
    .bind(device_id)
    .bind(&record.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if let Some(stored) = stored {
        return Ok(if stored == digest {
            accepted(record.id)
        } else {
            rejected(Some(record.id), warehouse_receipt_codes::PAYLOAD_MISMATCH)
        });
    }
    if !subject_exists(&mut *conn, &record).await? {
        return Ok(rejected(
            Some(record.id),
            warehouse_receipt_codes::SUBJECT_UNKNOWN,
        ));
    }
    sqlx::query(
        "INSERT INTO warehouse_reprints (device_id, record_id, digest, session_id, job_id, \
         attempt, subject_kind, subject_id, identity, reason_code, repair, template_id, \
         template_rev, outcome, error_code, operator_id, occurred_at, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device_id)
    .bind(&record.id)
    .bind(&digest)
    .bind(&record.session_id)
    .bind(&record.job_id)
    .bind(record.attempt)
    .bind(record.subject_kind.as_str())
    .bind(&record.subject_id)
    .bind(&record.identity)
    .bind(&record.reason_code)
    .bind(&record.repair)
    .bind(&record.template_id)
    .bind(record.template_rev)
    .bind(&record.outcome)
    .bind(&record.error_code)
    .bind(&record.operator_id)
    .bind(&record.occurred_at)
    .bind(received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(accepted(record.id))
}
```

В `apps/standalone/host/src/server.rs` найти добавленный в задаче 2 блок

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/warehouse/lookup",
            post(crate::routes::warehouse::lookup),
        )
```

и заменить на:

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/warehouse/lookup",
            post(crate::routes::warehouse::lookup),
        )
        .route(
            "/v1/device/warehouse/reprints",
            post(crate::routes::warehouse::receive_records),
        )
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test warehouse --test foundation --test backup_schema --test no_secrets_in_logs` — PASS (миграций теперь на одну больше; `foundation` сравнивает журнал с `MIGRATOR`). Если `office_shifts.rs` или `facts.rs` хоста перечисляют все таблицы схемы и падают на `warehouse_reprints` — дописать таблицу в их ожидания и записать в отклонения.

- [ ] **Шаг 4: мутации.** (а) В `receive` убрать проверку `subject_exists` — FAIL `records_are_kept_once_and_answered_like_facts`. (б) В `readable` заменить `None => !unsettled` на `None => true` — FAIL `each_field_of_a_record_keeps_its_rule`. Каждую вернуть (`cp`/`cmp`).

- [ ] **Шаг 5: коммит.** `cargo fmt … --check`; `git add apps/standalone/host/migrations/0015_warehouse_reprints.sql apps/standalone/host/src/routes/warehouse.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/warehouse.rs`; сообщение `feat(standalone): host keeps warehouse reprint records, migration 0015 (plan СКЛ task 3)` + трейлер. Сообщить контроллеру: хост `0015` занят планом СКЛ.

---

## Задача 4: база станции — сеансы, задания, записи (миграция оболочки `0012`)

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0012_warehouse_reprint.sql`
- Modify: `apps/standalone/src-tauri/src/local_db.rs` (`TABLE_CLASSES`), `apps/standalone/src-tauri/tests/local_db.rs`
- Create: `apps/standalone/src/floor/warehouse/warehouse-store.ts`, `apps/standalone/test/support/warehouse.ts`, `apps/standalone/test/warehouse-store.test.ts`
- Modify: `apps/standalone/test/floor-schema.test.ts`

**Interfaces (`warehouse-store.ts`):** типы `WarehouseReason`, `WarehouseOutcome`, `WarehouseRepair`, `WarehouseJobState`, `WarehouseTemplates`, `WarehouseSession`, `WarehouseJob`, `NewWarehouseJob`, `JobMove`; `UNRESOLVED_STATES`, `isUnresolved`; `readOpenSession`, `startSession`, `updateSession`, `finishSession` (`"finished" | "busy"`); `readOpenJob`, `readJobByIdentity`, `readJob`, `countSent`, `countUnsentRecords`; `insertJobStatement`, `moveJobStatement`, `warehouseRecord`, `recordStatement`; `purgeWarehouseSessions`; классы `StaleWarehouseError`, `UnreadableWarehouseJobError`; SQL-константы `OPEN_SESSION_SQL`, `OPEN_JOB_SQL`, `JOB_BY_IDENTITY_SQL`, `JOB_SQL`, `SENT_COUNT_SQL`, `UNSENT_RECORDS_SQL`, `MOVE_JOB_SQL`, `UPDATE_SESSION_SQL`, `FINISH_SESSION_SQL`, `DUE_SESSIONS_SQL`, `PURGE_SESSION_SQL`, `PURGE_JOBS_SQL`, `PURGE_RECORDS_SQL`, `WAREHOUSE_RETENTION_MS`.

- [ ] **Шаг 1: миграция.** Создать `apps/standalone/src-tauri/migrations/0012_warehouse_reprint.sql`:

<!-- prettier-ignore -->
```sql
-- Warehouse label reprint (plan СКЛ, pilot spec §30): the station's sessions
-- of reprinting, the print job of each label printed again, and the records
-- of each attempt that go to the host (`POST /v1/device/warehouse/reprints`).
-- A reprint belongs to no shift and makes no code, box or SSCC, so it has
-- tables of its own; `floor_print_jobs` keeps the labels of the line.
--
-- All three are this device's data (`TableClass::DeviceData`): every row
-- carries its pairing, a forget keeps them. No foreign keys (see `0006`).
-- Times are UTC as `Date.toISOString` writes them. A job walks:
--
--   prepared -> sending -> sent [-> verified]
--                       -> failed  (nothing left this computer) [-> cancelled]
--                       -> unknown (a label may exist: never sent again
--                                   without the operator's decision)
--   sent | verified | unknown -> sending (a new attempt with a reason)
--
-- `sending` is written before the bytes go, so a job found in `sending`
-- after a restart is `unknown`. The template's layout and the label's fields
-- are frozen in the job (`template_spec`, `fields`): an attempt repeats them.

CREATE TABLE wh_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('not_printed', 'damaged', 'lost')),
  unit_template_id TEXT,
  box_template_id TEXT,
  pallet_template_id TEXT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  finished_by TEXT,
  CHECK ((finished_at IS NULL) = (finished_by IS NULL))
);

-- One open session per pairing: a pause leaves it open, the next entry
-- continues it.
CREATE UNIQUE INDEX wh_sessions_open ON wh_sessions (host_id, device_id)
  WHERE finished_at IS NULL;
-- The retention reads the finished sessions by when they finished.
CREATE INDEX wh_sessions_finished ON wh_sessions (host_id, device_id, finished_at)
  WHERE finished_at IS NOT NULL;

CREATE TABLE wh_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unit', 'box', 'pallet')),
  subject_id TEXT NOT NULL,
  -- A unit's code hash or an SSCC: never a full code.
  identity TEXT NOT NULL,
  repair TEXT CHECK (repair IS NULL
    OR (repair = 'legacy_tspl_fnc1_literal' AND kind <> 'unit')),
  reason TEXT NOT NULL CHECK (reason IN ('not_printed', 'damaged', 'lost')),
  state TEXT NOT NULL CHECK (state IN
    ('prepared', 'sending', 'sent', 'failed', 'unknown', 'verified', 'cancelled')),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  template_spec TEXT NOT NULL CHECK (json_valid(template_spec)),
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  printer TEXT CHECK (printer IS NULL OR json_valid(printer)),
  bytes_base64 TEXT CHECK (bytes_base64 IS NULL OR length(bytes_base64) > 0),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (bytes_base64 IS NULL OR printer IS NOT NULL),
  CHECK (state NOT IN ('sending', 'sent', 'unknown', 'verified') OR bytes_base64 IS NOT NULL),
  CHECK ((error_code IS NOT NULL) = (state IN ('failed', 'unknown'))),
  CHECK (state <> 'prepared' OR attempts = 0)
);

-- At most one job of a session waits for the printer or the operator: the
-- session takes no new code and does not finish while one does.
CREATE UNIQUE INDEX wh_jobs_open ON wh_jobs (host_id, device_id, session_id)
  WHERE state IN ('prepared', 'sending', 'failed', 'unknown');
-- A code printed in the session is found by its identity (no repeat without
-- the operator's word); the session's counts and its purge read the same.
CREATE INDEX wh_jobs_session ON wh_jobs (host_id, device_id, session_id, identity);

CREATE TABLE wh_outbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'rejected')),
  outcome_code TEXT,
  acked_at TEXT,
  CHECK ((outcome IS NULL) = (acked_at IS NULL)),
  CHECK (outcome IS NOT NULL OR outcome_code IS NULL)
);

CREATE INDEX wh_outbox_unsent ON wh_outbox (host_id, device_id, seq) WHERE acked_at IS NULL;
CREATE INDEX wh_outbox_session ON wh_outbox (host_id, device_id, session_id);
```

- [ ] **Шаг 2: классы таблиц и тесты оболочки (RED → GREEN).** В `apps/standalone/src-tauri/src/local_db.rs` найти

<!-- prettier-ignore -->
```rust
    ("sync_state", TableClass::Disposable),
    ("workstation_settings", TableClass::Workstation),
];
```

и заменить на:

<!-- prettier-ignore -->
```rust
    ("sync_state", TableClass::Disposable),
    // The warehouse reprint (plan СКЛ, migration `0012`): this device's records.
    ("wh_jobs", TableClass::DeviceData),
    ("wh_outbox", TableClass::DeviceData),
    ("wh_sessions", TableClass::DeviceData),
    ("workstation_settings", TableClass::Workstation),
];
```

В `apps/standalone/src-tauri/tests/local_db.rs`:

- в `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` найти `            "sync_state",\n            "workstation_settings"\n        ]` и заменить на `            "sync_state",\n            "wh_jobs",\n            "wh_outbox",\n            "wh_sessions",\n            "workstation_settings"\n        ]`;
- там же найти

<!-- prettier-ignore -->
```rust
        Value::Array(
            (1..=MIGRATOR.iter().count())
                .map(|version| json!({ "version": version, "success": 1 }))
                .collect()
        ),
        "every migration is journaled once, in order"
    );
    assert!(MIGRATOR.iter().any(|migration| migration.version == 9));
```

и заменить на:

<!-- prettier-ignore -->
```rust
        Value::Array(
            MIGRATOR
                .iter()
                .map(|migration| json!({ "version": migration.version, "success": 1 }))
                .collect()
        ),
        // Parallel plans take numbers out of order (plan СКЛ takes `0012`
        // before `0010`/`0011` may land): the journal is the migrator's own list.
        "every migration is journaled once, in order"
    );
    assert!(MIGRATOR.iter().any(|migration| migration.version == 9));
    assert!(MIGRATOR.iter().any(|migration| migration.version == 12));
```

- в `every_table_has_a_forget_class` найти `            "floor_sscc_blocks",\n            "outbox"\n        ]` и заменить на `            "floor_sscc_blocks",\n            "outbox",\n            "wh_jobs",\n            "wh_outbox",\n            "wh_sessions"\n        ]`;
- дописать в конец файла тест планов (тексты — побайтно константы `warehouse-store.ts` и `warehouse-sender.ts`; задача 6 добавляет сюда три текста отправителя, поэтому они уже здесь):

<!-- prettier-ignore -->
```rust
/// The warehouse reprint's reads and writes (plan СКЛ, `src/floor/warehouse/warehouse-store.ts`
/// and `src/local/warehouse-sender.ts`; `test/floor-schema.test.ts` checks the texts agree)
/// search an index, never a whole table: jobs and records grow with every label printed again
/// and stay 30 days after their session finished.
#[tokio::test]
async fn the_warehouse_reads_search_an_index() {
    let (dir, db) = open().await;
    drop(db);
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    let jobs = "SELECT id, session_id, kind, subject_id, identity, repair, reason, state, \
                template_id, template_rev, template_spec, fields, printer, bytes_base64, \
                error_code, attempts, operator_id, created_at, updated_at FROM wh_jobs";
    let open_job = format!(
        "{jobs} WHERE host_id = ? AND device_id = ? AND session_id = ? \
         AND state IN ('prepared', 'sending', 'failed', 'unknown')"
    );
    let by_identity = format!(
        "{jobs} WHERE host_id = ? AND device_id = ? AND session_id = ? AND identity = ? \
         AND state <> 'cancelled' ORDER BY rowid DESC LIMIT 1"
    );
    let by_id = format!("{jobs} WHERE host_id = ? AND device_id = ? AND id = ?");
    // (the statement, what its plan must name)
    let reads: Vec<(String, &str)> = vec![
        (
            "SELECT id, reason, unit_template_id, box_template_id, pallet_template_id, \
             started_by, started_at FROM wh_sessions WHERE host_id = ? AND device_id = ? \
             AND finished_at IS NULL"
                .to_owned(),
            "wh_sessions_open",
        ),
        (open_job, "(host_id=? AND device_id=? AND session_id=?)"),
        (
            by_identity,
            "wh_jobs_session (host_id=? AND device_id=? AND session_id=? AND identity=?)",
        ),
        (by_id, "sqlite_autoindex_wh_jobs_1 (id=?)"),
        (
            "SELECT count(*) AS n FROM wh_jobs WHERE host_id = ? AND device_id = ? \
             AND session_id = ? AND state IN ('sent', 'verified')"
                .to_owned(),
            "wh_jobs_session (host_id=? AND device_id=? AND session_id=?)",
        ),
        (
            "SELECT count(*) AS n FROM wh_outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL"
                .to_owned(),
            "wh_outbox_unsent",
        ),
        (
            "UPDATE wh_jobs SET state = ?, error_code = ?, attempts = ?, reason = ?, \
             printer = ?, bytes_base64 = ?, updated_at = ? WHERE host_id = ? AND device_id = ? \
             AND id = ? AND state = ? AND attempts = ?"
                .to_owned(),
            "sqlite_autoindex_wh_jobs_1 (id=?)",
        ),
        (
            "UPDATE wh_sessions SET reason = ?, unit_template_id = ?, box_template_id = ?, \
             pallet_template_id = ?, updated_at = ? WHERE host_id = ? AND device_id = ? \
             AND id = ? AND finished_at IS NULL"
                .to_owned(),
            // By its key or by the pairing's one open session: either is one row.
            "SEARCH wh_sessions USING",
        ),
        (
            "UPDATE wh_sessions SET finished_at = ?, finished_by = ?, updated_at = ? \
             WHERE host_id = ? AND device_id = ? AND id = ? AND finished_at IS NULL \
             AND NOT EXISTS (SELECT 1 FROM wh_jobs j WHERE j.host_id = wh_sessions.host_id \
             AND j.device_id = wh_sessions.device_id AND j.session_id = wh_sessions.id \
             AND j.state IN ('prepared', 'sending', 'failed', 'unknown'))"
                .to_owned(),
            "SEARCH wh_sessions USING",
        ),
        (
            "SELECT s.id FROM wh_sessions s WHERE s.host_id = ? AND s.device_id = ? \
             AND s.finished_at IS NOT NULL AND s.finished_at <= ? AND NOT EXISTS (SELECT 1 \
             FROM wh_outbox o WHERE o.host_id = s.host_id AND o.device_id = s.device_id \
             AND o.session_id = s.id AND o.outcome IS NOT 'accepted')"
                .to_owned(),
            "wh_sessions_finished",
        ),
        (
            "DELETE FROM wh_sessions WHERE host_id = ? AND device_id = ? AND id = ? \
             AND finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wh_outbox o \
             WHERE o.host_id = wh_sessions.host_id AND o.device_id = wh_sessions.device_id \
             AND o.session_id = wh_sessions.id AND o.outcome IS NOT 'accepted')"
                .to_owned(),
            "SEARCH wh_sessions USING",
        ),
        (
            "DELETE FROM wh_jobs WHERE host_id = ? AND device_id = ? AND session_id = ?"
                .to_owned(),
            "wh_jobs_session (host_id=? AND device_id=? AND session_id=?)",
        ),
        (
            "DELETE FROM wh_outbox WHERE host_id = ? AND device_id = ? AND session_id = ?"
                .to_owned(),
            "wh_outbox_session (host_id=? AND device_id=? AND session_id=?)",
        ),
        (
            "SELECT id, payload FROM wh_outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL ORDER BY seq LIMIT ?"
                .to_owned(),
            "wh_outbox_unsent",
        ),
        (
            "UPDATE wh_outbox SET attempts = attempts + 1, sent_at = ? WHERE +host_id = ? \
             AND +device_id = ? AND id IN (SELECT value FROM json_each(?))"
                .to_owned(),
            "sqlite_autoindex_wh_outbox_1 (id=?)",
        ),
        (
            "UPDATE wh_outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> \
             'code', acked_at = ? FROM json_each(?) AS r WHERE wh_outbox.id = r.value ->> 'id' \
             AND +wh_outbox.host_id = ? AND +wh_outbox.device_id = ? AND +wh_outbox.acked_at \
             IS NULL"
                .to_owned(),
            "sqlite_autoindex_wh_outbox_1 (id=?)",
        ),
    ];
    for (sql, index) in &reads {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut explain = sqlx::query(&text);
        for _ in 0..sql.matches('?').count() {
            explain = explain.bind("x");
        }
        let plan: Vec<String> = explain
            .fetch_all(&mut raw)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert!(
            plan.iter().any(|step| step.contains(index)),
            "{sql}\n  should use {index}, its plan is {plan:?}"
        );
        // `json_each` (alias `r` in the receipt's `UPDATE … FROM`) is the batch's own list.
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN ")
                && !step.contains("json_each")
                && !step.starts_with("SCAN r ")),
            "{sql}\n  scans a table: {plan:?}"
        );
    }
    raw.close().await.unwrap();
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`, затем `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db` — PASS. Если какой-то план выбирает другой индекс (SQLite 3.46 оболочки), поправить ожидание индекса, а не SQL, и записать в отклонения; если план читает таблицу целиком — менять SQL (как унарные плюсы отправителя) и тот же текст в TS.

- [ ] **Шаг 3: опора тестов.** Создать `apps/standalone/test/support/warehouse.ts`:

<!-- prettier-ignore -->
```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
} from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";

import { latin1ToBytes } from "../../src/floor/print/label-render.js";
import type { RenderWarehouseLabel } from "../../src/floor/warehouse/warehouse-work.js";
import type { WarehouseSource } from "../../src/host/protocol.js";
import { ENTITY_SET } from "../../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./fixtures.js";
import { OPERATOR_ID } from "./floor-work.js";

/** The three templates of the copies: a duplicate, a box and a pallet, all for every category. */
export const UNIT_TEMPLATE = "d1d1d1d1-0000-4000-8000-000000000001";
export const BOX_TEMPLATE = "d1d1d1d1-0000-4000-8000-000000000002";
export const PALLET_TEMPLATE = "d1d1d1d1-0000-4000-8000-000000000003";

/** A unit's full code with its separator and crypto tail, and its `kmHash`. */
export const KM = "010460068200001321S000001\u001d93Tail";
export const CODE_HASH = "7a6ad5f358a3f6d800e0550c5bc16079d73004e9766bfc13c572778c62a6657d";
/** The SSCC of box serial 1500 and of pallet serial 40 under 460068200, with their check digits. */
export const BOX_SSCC = "046006820000015000";
export const PALLET_SSCC = "146006820000000409";

const PRODUCT = {
  id: "8b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  shelfLifeDays: 10,
};

export const UNIT_SOURCE: WarehouseSource = {
  kind: "unit",
  subjectId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
  identity: CODE_HASH,
  canonical: KM,
  product: PRODUCT,
  counterpartyName: null,
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  productionDate: "2026-10-08",
  at: "2026-10-08T05:58:41.090Z",
  itemCount: 1,
  operatorName: "Анна Кузнецова",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
};

export const BOX_SOURCE: WarehouseSource = {
  kind: "box",
  subjectId: "b0000000-0000-4000-8000-000000000001",
  identity: BOX_SSCC,
  sscc: BOX_SSCC,
  product: PRODUCT,
  counterpartyName: "ООО «Север»",
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  productionDate: "2026-10-08",
  at: "2026-10-08T06:10:00.000Z",
  itemCount: 12,
  operatorName: "Анна Кузнецова",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
};

export const PALLET_SOURCE: WarehouseSource = {
  kind: "pallet",
  subjectId: "a0000000-0000-4000-8000-000000000001",
  identity: PALLET_SSCC,
  sscc: PALLET_SSCC,
  product: PRODUCT,
  counterpartyName: null,
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  productionDate: "2026-10-08",
  at: "2026-10-08T06:20:00.000Z",
  itemCount: 480,
  boxCount: 40,
  operatorName: null,
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
};

/**
 * This pairing's copies, ready: Anna (unless `operator: false`), the organization with
 * the three templates as its defaults, and the templates themselves (stock layouts).
 */
export function seedWarehouseCopies(db: DatabaseSync, options: { operator?: boolean } = {}): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) " +
      "VALUES ('last_rev', '10'), ('host_id', ?), ('device_id', ?), ('entity_set', ?)",
  ).run(HOST_ID, DEVICE_ID, ENTITY_SET);
  if (options.operator !== false) {
    db.prepare(
      "INSERT INTO ref_operators (id, login, name, role, pin_phc, rev) " +
        "VALUES (?, '0042', 'Анна Кузнецова', NULL, 'x', 1)",
    ).run(OPERATOR_ID);
  }
  db.prepare(
    "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, rev, " +
      "default_box_template_id, default_pallet_template_id, default_duplicate_template_id) " +
      "VALUES ('org', 'Завод', NULL, '4600682000006', '[]', 'Europe/Moscow', 1, ?, ?, ?)",
  ).run(BOX_TEMPLATE, PALLET_TEMPLATE, UNIT_TEMPLATE);
  const [box] = buildDefaultLabelTemplates();
  const [pallet] = buildPalletLabelTemplates();
  if (box === undefined || pallet === undefined) throw new Error("stock templates missing");
  const insert = db.prepare(
    "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, stock, spec, rev) " +
      "VALUES (?, ?, ?, 1, NULL, 1, ?, 4)",
  );
  insert.run(UNIT_TEMPLATE, "Дубль 58×40", "product_duplicate", JSON.stringify(buildDuplicateLabelTemplate()));
  insert.run(BOX_TEMPLATE, "Коробка 58×40", "box", JSON.stringify(box.spec));
  insert.run(PALLET_TEMPLATE, "Палета 100×150", "pallet", JSON.stringify(pallet.spec));
}

/**
 * A render that writes what it was asked in plain ASCII: the language, the resolution,
 * the layout's size, the SSCC (or `km` for a unit) and how the code is drawn.
 */
export const warehouseRender: RenderWarehouseLabel = async (spec, fields, printer, options) =>
  latin1ToBytes(
    `^XA ${printer.language} ${printer.dpi} ${spec.widthMm}x${spec.heightMm} ` +
      `${fields.sscc === "" ? "km" : fields.sscc} ${options.kmDataMatrix ?? "native"} ^XZ`,
  );
```

(Если `buildPalletLabelTemplates` или `buildDefaultLabelTemplates` в индексе домена называются иначе — взять тот экспорт `packages/domain/src/index.ts`, что строит типовые шаблоны мастера, `src/wizard/wizard-form.ts`; записать в отклонения.)

- [ ] **Шаг 4: тест хранилища (RED).** Создать `apps/standalone/test/warehouse-store.test.ts`:

<!-- prettier-ignore -->
```ts
import { boxLabelFields } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  countSent,
  countUnsentRecords,
  finishSession,
  insertJobStatement,
  moveJobStatement,
  purgeWarehouseSessions,
  readJob,
  readJobByIdentity,
  readOpenJob,
  readOpenSession,
  recordStatement,
  startSession,
  StaleWarehouseError,
  updateSession,
  warehouseRecord,
  type NewWarehouseJob,
} from "../src/floor/warehouse/warehouse-store.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { ZEBRA } from "./support/printing.js";
import { BOX_SSCC, BOX_TEMPLATE, UNIT_TEMPLATE } from "./support/warehouse.js";

const AT = "2026-10-09T07:00:00.000Z";
const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const TEMPLATES = { unit: UNIT_TEMPLATE, box: BOX_TEMPLATE, pallet: null };

const FIELDS = boxLabelFields({
  sscc: BOX_SSCC,
  itemCount: 12,
  productName: "Молоко 3,2% 0,9 л",
  productPrintName: "Молоко 3,2%",
  gtin14: "04600682000013",
  egaisCode: null,
  shelfLifeDays: 10,
  operatorName: "Анна Кузнецова",
  counterpartyName: null,
  closedAt: "2026-10-08T06:10:00.000Z",
  productionDate: "2026-10-08",
  shiftNumber: "OCT26-003",
});

function job(id: string, overrides: Partial<NewWarehouseJob> = {}): NewWarehouseJob {
  return {
    id,
    sessionId: SESSION,
    kind: "box",
    subjectId: "b0000000-0000-4000-8000-000000000001",
    identity: BOX_SSCC,
    repair: null,
    reason: "damaged",
    state: "prepared",
    templateId: BOX_TEMPLATE,
    templateRev: 4,
    templateSpec: "{}",
    fields: FIELDS,
    printer: ZEBRA,
    bytesBase64: "XlhB",
    errorCode: null,
    operatorId: OPERATOR_ID,
    createdAt: AT,
    ...overrides,
  };
}

describe("the warehouse reprint's own tables (migration 0012)", () => {
  it("keep one open session per pairing, continued after a pause and never after its finish", async () => {
    const { executor } = openLocalDb();
    expect(await readOpenSession(executor, PAIRING)).toBeNull();
    const started = await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    expect(await readOpenSession(executor, PAIRING)).toEqual(started);
    // A second start while one is open answers the open one.
    const again = await startSession(executor, PAIRING, {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      reason: "lost",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    expect(again.id).toBe(SESSION);
    await updateSession(executor, PAIRING, { ...started, reason: "lost" }, AT);
    expect((await readOpenSession(executor, PAIRING))?.reason).toBe("lost");
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("finished");
    expect(await readOpenSession(executor, PAIRING)).toBeNull();
    await expect(updateSession(executor, PAIRING, started, AT)).rejects.toBeInstanceOf(
      StaleWarehouseError,
    );
  });

  it("hold one waiting job per session, and no finish while it waits", async () => {
    const { executor } = openLocalDb();
    await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    await executor.transaction([insertJobStatement(PAIRING, job("job-1"))]);
    await expect(
      executor.transaction([insertJobStatement(PAIRING, job("job-2", { identity: "x" }))]),
    ).rejects.toMatchObject({ code: "statement_failed" });
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("busy");
    const waiting = await readOpenJob(executor, PAIRING, SESSION);
    expect(waiting?.id).toBe("job-1");
    if (waiting === null) throw new Error("the job waits");
    // `sending`, then `sent`: the job is done with, and the session may finish.
    await executor.transaction([
      moveJobStatement(PAIRING, waiting, { state: "sending", errorCode: null, attempts: 1, reason: "damaged", printer: ZEBRA, bytesBase64: "XlhB" }, AT),
    ]);
    const sending = await readJob(executor, PAIRING, "job-1");
    if (sending === null) throw new Error("the job is there");
    await executor.transaction([
      moveJobStatement(PAIRING, sending, { state: "sent", errorCode: null, attempts: 1, reason: "damaged", printer: ZEBRA, bytesBase64: "XlhB" }, AT),
    ]);
    // A move from a state the job left is refused.
    await expect(
      executor.transaction([
        moveJobStatement(PAIRING, sending, { state: "unknown", errorCode: "timeout", attempts: 1, reason: "damaged", printer: ZEBRA, bytesBase64: "XlhB" }, AT),
      ]),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(await countSent(executor, PAIRING, SESSION)).toBe(1);
    expect((await readJobByIdentity(executor, PAIRING, SESSION, BOX_SSCC))?.state).toBe("sent");
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("finished");
  });

  it("refuse a job that breaks its rules", async () => {
    const { db, executor } = openLocalDb();
    const refused = async (overrides: Partial<NewWarehouseJob>) =>
      expect(
        executor.transaction([insertJobStatement(PAIRING, job(crypto.randomUUID(), overrides))]),
      ).rejects.toMatchObject({ code: "statement_failed" });
    await refused({ state: "failed", errorCode: null });
    await refused({ state: "prepared", errorCode: "timeout" });
    await refused({ printer: null });
    await refused({ kind: "unit", repair: "legacy_tspl_fnc1_literal" });
    // A reason outside the list, written past the types.
    const statement = insertJobStatement(PAIRING, job("job-9"));
    const values = [...statement.values];
    values[8] = "other";
    await expect(executor.transaction([{ ...statement, values }])).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(db, "SELECT id FROM wh_jobs")).toEqual([]);
  });

  it("keep the records of a job for the host, in their order, and count the unsent ones", async () => {
    const { db, executor } = openLocalDb();
    const record = warehouseRecord(job("4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a"), {
      id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      attempt: 1,
      reason: "damaged",
      outcome: "sent",
      errorCode: null,
      operatorId: OPERATOR_ID,
      occurredAt: AT,
    });
    expect(record).toEqual({
      id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      sessionId: SESSION,
      jobId: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
      attempt: 1,
      subjectKind: "box",
      subjectId: "b0000000-0000-4000-8000-000000000001",
      identity: BOX_SSCC,
      reasonCode: "damaged",
      repair: null,
      templateId: BOX_TEMPLATE,
      templateRev: 4,
      outcome: "sent",
      errorCode: null,
      operatorId: OPERATOR_ID,
      occurredAt: AT,
    });
    await executor.transaction([recordStatement(PAIRING, record, AT)]);
    expect(await countUnsentRecords(executor, PAIRING)).toBe(1);
    expect(rows(db, "SELECT session_id, payload FROM wh_outbox")).toEqual([
      { session_id: SESSION, payload: JSON.stringify(record) },
    ]);
  });

  it("forget a finished session 30 days after its records were all accepted, and only then", async () => {
    const { db, executor } = openLocalDb();
    await startSession(executor, PAIRING, { id: SESSION, reason: "damaged", templates: TEMPLATES, operatorId: OPERATOR_ID, at: AT });
    await executor.transaction([
      insertJobStatement(PAIRING, job("job-1", { state: "failed", errorCode: "printer_unconfigured", printer: null, bytesBase64: null })),
    ]);
    const failed = await readJob(executor, PAIRING, "job-1");
    if (failed === null) throw new Error("the job is there");
    await executor.transaction([
      moveJobStatement(PAIRING, failed, { state: "cancelled", errorCode: null, attempts: 0, reason: "damaged", printer: null, bytesBase64: null }, AT),
      recordStatement(PAIRING, warehouseRecord(failed, { id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b", attempt: 0, reason: "damaged", outcome: "cancelled", errorCode: null, operatorId: OPERATOR_ID, occurredAt: AT }), AT),
    ]);
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("finished");
    const later = new Date(Date.parse(AT) + 31 * 24 * 3600 * 1000);
    // The record has no receipt yet: the session stays.
    expect(await purgeWarehouseSessions(executor, PAIRING, later)).toBe(0);
    db.prepare("UPDATE wh_outbox SET outcome = 'rejected', outcome_code = 'subject_unknown', acked_at = ?").run(AT);
    expect(await purgeWarehouseSessions(executor, PAIRING, later)).toBe(0);
    db.prepare("UPDATE wh_outbox SET outcome = 'accepted', outcome_code = NULL").run();
    expect(await purgeWarehouseSessions(executor, PAIRING, new Date(Date.parse(AT) + 1000))).toBe(0);
    expect(await purgeWarehouseSessions(executor, PAIRING, later)).toBe(1);
    for (const table of ["wh_sessions", "wh_jobs", "wh_outbox"]) {
      expect(
        await executor.query(`SELECT count(*) AS n FROM ${table}`, [], z.object({ n: z.number() })),
      ).toEqual([{ n: 0 }]);
    }
  });
});
```

(Индекс `values[8]` — `reason` в `insertJobStatement`: `host_id, device_id, id, session_id, kind, subject_id, identity, repair, reason`.)

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-store.test.ts` — FAIL (модуля нет).

- [ ] **Шаг 5: модуль хранилища.** Создать `apps/standalone/src/floor/warehouse/warehouse-store.ts`:

<!-- prettier-ignore -->
```ts
import { LABEL_FIELDS } from "@markiro/domain";
import { z } from "zod";

import {
  WAREHOUSE_REASONS,
  WAREHOUSE_SUBJECT_KINDS,
  type WAREHOUSE_OUTCOMES,
  type WarehouseRecord,
  type WarehouseSubjectKind,
} from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { LabelFields } from "../print/label-render.js";
import { parsePrinterProfile, type PrinterProfile } from "../setup/workstation-settings.js";

/** Why a label is printed again (plan СКЛ, decision Р9). */
export type WarehouseReason = (typeof WAREHOUSE_REASONS)[number];
/** Where one attempt ended (`markiro_proto::WAREHOUSE_OUTCOMES`). */
export type WarehouseOutcome = (typeof WAREHOUSE_OUTCOMES)[number];
/** A box label of the old TSPL defect (`!1` + SSCC), found by the domain's warehouse scan rule. */
export type WarehouseRepair = "legacy_tspl_fnc1_literal";

/** A reprint job's states (migration `0012`). */
export const WAREHOUSE_JOB_STATES = [
  "prepared",
  "sending",
  "sent",
  "failed",
  "unknown",
  "verified",
  "cancelled",
] as const;
export type WarehouseJobState = (typeof WAREHOUSE_JOB_STATES)[number];

/** A job that waits for the printer or the operator (the index `wh_jobs_open`). */
export const UNRESOLVED_STATES: readonly WarehouseJobState[] = [
  "prepared",
  "sending",
  "failed",
  "unknown",
];

export function isUnresolved(state: WarehouseJobState): boolean {
  return UNRESOLVED_STATES.includes(state);
}

/** The template chosen for each kind of label; `null` — none yet. */
export type WarehouseTemplates = Record<WarehouseSubjectKind, string | null>;

/** A session of reprinting: its reason and templates for the next jobs. */
export interface WarehouseSession {
  id: string;
  reason: WarehouseReason;
  templates: WarehouseTemplates;
  startedBy: string;
  startedAt: string;
}

/** A reprint job as stored. */
export interface WarehouseJob {
  id: string;
  sessionId: string;
  kind: WarehouseSubjectKind;
  subjectId: string;
  identity: string;
  repair: WarehouseRepair | null;
  reason: WarehouseReason;
  state: WarehouseJobState;
  templateId: string;
  templateRev: number;
  /** The template's layout as JSON text, frozen when the job was made. */
  templateSpec: string;
  fields: LabelFields;
  printer: PrinterProfile | null;
  bytesBase64: string | null;
  errorCode: string | null;
  attempts: number;
  operatorId: string;
  createdAt: string;
  updatedAt: string;
}

/** A new job: `prepared` with its bytes, or `failed` with the reason it has none. */
export type NewWarehouseJob = Omit<WarehouseJob, "attempts" | "updatedAt" | "state"> & {
  state: "prepared" | "failed";
};

/** What a move of a job writes besides its time. */
export interface JobMove {
  state: WarehouseJobState;
  errorCode: string | null;
  attempts: number;
  reason: WarehouseReason;
  printer: PrinterProfile | null;
  bytesBase64: string | null;
}

/** The session or the job changed between the read and the write. */
export class StaleWarehouseError extends Error {
  constructor(id: string) {
    super(`warehouse row ${id} changed meanwhile`);
    this.name = "StaleWarehouseError";
  }
}

/** A stored job this build cannot read (a damaged profile or fields). */
export class UnreadableWarehouseJobError extends Error {
  constructor(id: string) {
    super(`warehouse job ${id} cannot be read`);
    this.name = "UnreadableWarehouseJobError";
  }
}

export const OPEN_SESSION_SQL =
  "SELECT id, reason, unit_template_id, box_template_id, pallet_template_id, started_by, " +
  "started_at FROM wh_sessions WHERE host_id = ? AND device_id = ? AND finished_at IS NULL";

const JOB_COLUMNS =
  "SELECT id, session_id, kind, subject_id, identity, repair, reason, state, template_id, " +
  "template_rev, template_spec, fields, printer, bytes_base64, error_code, attempts, " +
  "operator_id, created_at, updated_at FROM wh_jobs";

export const OPEN_JOB_SQL =
  `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND session_id = ? ` +
  "AND state IN ('prepared', 'sending', 'failed', 'unknown')";

export const JOB_BY_IDENTITY_SQL =
  `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND session_id = ? AND identity = ? ` +
  "AND state <> 'cancelled' ORDER BY rowid DESC LIMIT 1";

export const JOB_SQL = `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND id = ?`;

export const SENT_COUNT_SQL =
  "SELECT count(*) AS n FROM wh_jobs WHERE host_id = ? AND device_id = ? " +
  "AND session_id = ? AND state IN ('sent', 'verified')";

export const UNSENT_RECORDS_SQL =
  "SELECT count(*) AS n FROM wh_outbox WHERE host_id = ? AND device_id = ? " +
  "AND acked_at IS NULL";

export const MOVE_JOB_SQL =
  "UPDATE wh_jobs SET state = ?, error_code = ?, attempts = ?, reason = ?, printer = ?, " +
  "bytes_base64 = ?, updated_at = ? WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND state = ? AND attempts = ?";

export const UPDATE_SESSION_SQL =
  "UPDATE wh_sessions SET reason = ?, unit_template_id = ?, box_template_id = ?, " +
  "pallet_template_id = ?, updated_at = ? WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND finished_at IS NULL";

export const FINISH_SESSION_SQL =
  "UPDATE wh_sessions SET finished_at = ?, finished_by = ?, updated_at = ? " +
  "WHERE host_id = ? AND device_id = ? AND id = ? AND finished_at IS NULL " +
  "AND NOT EXISTS (SELECT 1 FROM wh_jobs j WHERE j.host_id = wh_sessions.host_id " +
  "AND j.device_id = wh_sessions.device_id AND j.session_id = wh_sessions.id " +
  "AND j.state IN ('prepared', 'sending', 'failed', 'unknown'))";

/** How long a finished session whose records the host all accepted is kept (decision Р18). */
export const WAREHOUSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const DUE_SESSIONS_SQL =
  "SELECT s.id FROM wh_sessions s WHERE s.host_id = ? AND s.device_id = ? " +
  "AND s.finished_at IS NOT NULL AND s.finished_at <= ? AND NOT EXISTS (SELECT 1 " +
  "FROM wh_outbox o WHERE o.host_id = s.host_id AND o.device_id = s.device_id " +
  "AND o.session_id = s.id AND o.outcome IS NOT 'accepted')";

export const PURGE_SESSION_SQL =
  "DELETE FROM wh_sessions WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wh_outbox o " +
  "WHERE o.host_id = wh_sessions.host_id AND o.device_id = wh_sessions.device_id " +
  "AND o.session_id = wh_sessions.id AND o.outcome IS NOT 'accepted')";

export const PURGE_JOBS_SQL =
  "DELETE FROM wh_jobs WHERE host_id = ? AND device_id = ? AND session_id = ?";

export const PURGE_RECORDS_SQL =
  "DELETE FROM wh_outbox WHERE host_id = ? AND device_id = ? AND session_id = ?";

const sessionRow = z.object({
  id: z.string(),
  reason: z.enum(WAREHOUSE_REASONS),
  unit_template_id: z.string().nullable(),
  box_template_id: z.string().nullable(),
  pallet_template_id: z.string().nullable(),
  started_by: z.string(),
  started_at: z.string(),
});

const jobRow = z.object({
  id: z.string(),
  session_id: z.string(),
  kind: z.enum(WAREHOUSE_SUBJECT_KINDS),
  subject_id: z.string(),
  identity: z.string(),
  repair: z.literal("legacy_tspl_fnc1_literal").nullable(),
  reason: z.enum(WAREHOUSE_REASONS),
  state: z.enum(WAREHOUSE_JOB_STATES),
  template_id: z.string(),
  template_rev: z.number().int(),
  template_spec: z.string(),
  fields: z.string(),
  printer: z.string().nullable(),
  bytes_base64: z.string().nullable(),
  error_code: z.string().nullable(),
  attempts: z.number().int(),
  operator_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const fieldsSchema = z.record(z.enum(LABEL_FIELDS), z.string());
const countRow = z.object({ n: z.number().int().nonnegative() });
const idRow = z.object({ id: z.string() });

function toSession(row: z.infer<typeof sessionRow>): WarehouseSession {
  return {
    id: row.id,
    reason: row.reason,
    templates: {
      unit: row.unit_template_id,
      box: row.box_template_id,
      pallet: row.pallet_template_id,
    },
    startedBy: row.started_by,
    startedAt: row.started_at,
  };
}

function toJob(row: z.infer<typeof jobRow>): WarehouseJob {
  let printer: PrinterProfile | null = null;
  let fields: LabelFields;
  try {
    if (row.printer !== null) {
      printer = parsePrinterProfile(JSON.parse(row.printer));
      if (printer === null) throw new UnreadableWarehouseJobError(row.id);
    }
    fields = fieldsSchema.parse(JSON.parse(row.fields));
  } catch {
    throw new UnreadableWarehouseJobError(row.id);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    subjectId: row.subject_id,
    identity: row.identity,
    repair: row.repair,
    reason: row.reason,
    state: row.state,
    templateId: row.template_id,
    templateRev: row.template_rev,
    templateSpec: row.template_spec,
    fields,
    printer,
    bytesBase64: row.bytes_base64,
    errorCode: row.error_code,
    attempts: row.attempts,
    operatorId: row.operator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The pairing's open session, or `null`. */
export async function readOpenSession(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<WarehouseSession | null> {
  const [row] = await local.query(
    OPEN_SESSION_SQL,
    [pairing.hostId, pairing.deviceId],
    sessionRow,
  );
  return row === undefined ? null : toSession(row);
}

/**
 * Starts a session; when one is open already (another start won the race), that
 * one is the session: one open session per pairing (`wh_sessions_open`).
 */
export async function startSession(
  local: LocalExecutor,
  pairing: Pairing,
  input: {
    id: string;
    reason: WarehouseReason;
    templates: WarehouseTemplates;
    operatorId: string;
    at: string;
  },
): Promise<WarehouseSession> {
  try {
    await local.transaction([
      {
        sql:
          "INSERT INTO wh_sessions (id, host_id, device_id, reason, unit_template_id, " +
          "box_template_id, pallet_template_id, started_by, started_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values: [
          input.id,
          pairing.hostId,
          pairing.deviceId,
          input.reason,
          input.templates.unit,
          input.templates.box,
          input.templates.pallet,
          input.operatorId,
          input.at,
          input.at,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (!(error instanceof LocalDbError)) throw error;
    const open = await readOpenSession(local, pairing);
    if (open === null) throw error;
    return open;
  }
  return {
    id: input.id,
    reason: input.reason,
    templates: input.templates,
    startedBy: input.operatorId,
    startedAt: input.at,
  };
}

/** Writes the session's reason and templates for its next jobs; a finished session is stale. */
export async function updateSession(
  local: LocalExecutor,
  pairing: Pairing,
  session: WarehouseSession,
  at: string,
): Promise<void> {
  try {
    await local.transaction([
      {
        sql: UPDATE_SESSION_SQL,
        values: [
          session.reason,
          session.templates.unit,
          session.templates.box,
          session.templates.pallet,
          at,
          pairing.hostId,
          pairing.deviceId,
          session.id,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleWarehouseError(session.id);
    }
    throw error;
  }
}

/** Finishes the session unless a job of it waits (`busy`); a finished session is never continued. */
export async function finishSession(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
  operatorId: string,
  at: string,
): Promise<"finished" | "busy"> {
  try {
    await local.transaction([
      {
        sql: FINISH_SESSION_SQL,
        values: [at, operatorId, at, pairing.hostId, pairing.deviceId, sessionId],
        expectedChanges: 1,
      },
    ]);
    return "finished";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "busy";
    throw error;
  }
}

async function oneJob(
  local: LocalExecutor,
  sql: string,
  values: readonly unknown[],
): Promise<WarehouseJob | null> {
  const [row] = await local.query(sql, values, jobRow);
  return row === undefined ? null : toJob(row);
}

/** The session's job that waits for the printer or the operator, or `null`. */
export function readOpenJob(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
): Promise<WarehouseJob | null> {
  return oneJob(local, OPEN_JOB_SQL, [pairing.hostId, pairing.deviceId, sessionId]);
}

/** The session's newest job of this code or SSCC that was not cancelled, or `null`. */
export function readJobByIdentity(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
  identity: string,
): Promise<WarehouseJob | null> {
  return oneJob(local, JOB_BY_IDENTITY_SQL, [pairing.hostId, pairing.deviceId, sessionId, identity]);
}

/** The job `id` of the pairing, or `null`. */
export function readJob(
  local: LocalExecutor,
  pairing: Pairing,
  id: string,
): Promise<WarehouseJob | null> {
  return oneJob(local, JOB_SQL, [pairing.hostId, pairing.deviceId, id]);
}

/** How many labels of the session went to a printer (sent or checked). */
export async function countSent(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
): Promise<number> {
  const [row] = await local.query(
    SENT_COUNT_SQL,
    [pairing.hostId, pairing.deviceId, sessionId],
    countRow,
  );
  return row?.n ?? 0;
}

/** How many records of the pairing wait for the host's receipt. */
export async function countUnsentRecords(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const [row] = await local.query(UNSENT_RECORDS_SQL, [pairing.hostId, pairing.deviceId], countRow);
  return row?.n ?? 0;
}

/** The row of a new job; with `wh_jobs_open` it refuses a second waiting job of the session. */
export function insertJobStatement(pairing: Pairing, job: NewWarehouseJob): LocalStatement {
  return {
    sql:
      "INSERT INTO wh_jobs (host_id, device_id, id, session_id, kind, subject_id, identity, " +
      "repair, reason, state, template_id, template_rev, template_spec, fields, printer, " +
      "bytes_base64, error_code, attempts, operator_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    values: [
      pairing.hostId,
      pairing.deviceId,
      job.id,
      job.sessionId,
      job.kind,
      job.subjectId,
      job.identity,
      job.repair,
      job.reason,
      job.state,
      job.templateId,
      job.templateRev,
      job.templateSpec,
      JSON.stringify(job.fields),
      job.printer === null ? null : JSON.stringify(job.printer),
      job.bytesBase64,
      job.errorCode,
      job.operatorId,
      job.createdAt,
      job.createdAt,
    ],
    expectedChanges: 1,
  };
}

/** A job's move from the state and attempt it was read in; another writer's move fails it. */
export function moveJobStatement(
  pairing: Pairing,
  job: Pick<WarehouseJob, "id" | "state" | "attempts">,
  move: JobMove,
  at: string,
): LocalStatement {
  return {
    sql: MOVE_JOB_SQL,
    values: [
      move.state,
      move.errorCode,
      move.attempts,
      move.reason,
      move.printer === null ? null : JSON.stringify(move.printer),
      move.bytesBase64,
      at,
      pairing.hostId,
      pairing.deviceId,
      job.id,
      job.state,
      job.attempts,
    ],
    expectedChanges: 1,
  };
}

/** The record of one attempt of a job, as the host takes it (`WarehouseRecord`). */
export function warehouseRecord(
  job: Pick<
    WarehouseJob,
    "id" | "sessionId" | "kind" | "subjectId" | "identity" | "repair" | "templateId" | "templateRev"
  >,
  attempt: {
    id: string;
    attempt: number;
    reason: WarehouseReason;
    outcome: WarehouseOutcome;
    errorCode: string | null;
    operatorId: string;
    occurredAt: string;
  },
): WarehouseRecord {
  return {
    id: attempt.id,
    sessionId: job.sessionId,
    jobId: job.id,
    attempt: attempt.attempt,
    subjectKind: job.kind,
    subjectId: job.subjectId,
    identity: job.identity,
    reasonCode: attempt.reason,
    repair: job.repair,
    templateId: job.templateId,
    templateRev: job.templateRev,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
    operatorId: attempt.operatorId,
    occurredAt: attempt.occurredAt,
  };
}

/** The record's row in `wh_outbox`, written with the move it records. */
export function recordStatement(
  pairing: Pairing,
  record: WarehouseRecord,
  createdAt: string,
): LocalStatement {
  return {
    sql:
      "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    values: [
      record.id,
      pairing.hostId,
      pairing.deviceId,
      record.sessionId,
      JSON.stringify(record),
      createdAt,
    ],
    expectedChanges: 1,
  };
}

/**
 * Deletes the pairing's sessions finished 30 days before `now` whose records the
 * host all accepted, with their jobs and records, one session per transaction; a
 * session that took a record meanwhile stays (its delete changes nothing and the
 * batch fails whole). Answers how many went.
 */
export async function purgeWarehouseSessions(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - WAREHOUSE_RETENTION_MS).toISOString();
  const { hostId, deviceId } = pairing;
  const due = await local.query(DUE_SESSIONS_SQL, [hostId, deviceId, cutoff], idRow);
  let purged = 0;
  for (const { id } of due) {
    try {
      await local.transaction([
        { sql: PURGE_SESSION_SQL, values: [hostId, deviceId, id], expectedChanges: 1 },
        { sql: PURGE_JOBS_SQL, values: [hostId, deviceId, id] },
        { sql: PURGE_RECORDS_SQL, values: [hostId, deviceId, id] },
      ]);
      purged += 1;
    } catch (error) {
      if (!(error instanceof LocalDbError && error.code === "changes_mismatch")) throw error;
    }
  }
  return purged;
}
```

(Ограничение `expectedChanges` первого оператора: если `LocalExecutor` проверяет его только для всего пакета, поведение то же — пакет откатывается.)

- [ ] **Шаг 6: планы на node:sqlite.** В `apps/standalone/test/floor-schema.test.ts` добавить импорт после строки `import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";`:

<!-- prettier-ignore -->
```ts
import {
  DUE_SESSIONS_SQL,
  FINISH_SESSION_SQL,
  JOB_BY_IDENTITY_SQL,
  JOB_SQL,
  MOVE_JOB_SQL,
  OPEN_JOB_SQL,
  OPEN_SESSION_SQL,
  PURGE_JOBS_SQL,
  PURGE_RECORDS_SQL,
  PURGE_SESSION_SQL,
  SENT_COUNT_SQL,
  UNSENT_RECORDS_SQL,
  UPDATE_SESSION_SQL,
} from "../src/floor/warehouse/warehouse-store.js";
```

и дописать в конец файла:

<!-- prettier-ignore -->
```ts
// The warehouse reprint (plan СКЛ, migration 0012): every read and write of its growing tables
// searches an index; pinned on the shell's SQLite too (`the_warehouse_reads_search_an_index`
// in `tests/local_db.rs`), with the same texts.
describe("the warehouse reprint's statements (migration 0012)", () => {
  const STATEMENTS: readonly (readonly [string, string])[] = [
    [OPEN_SESSION_SQL, "wh_sessions_open"],
    [OPEN_JOB_SQL, "(host_id=? AND device_id=? AND session_id=?)"],
    [JOB_BY_IDENTITY_SQL, "wh_jobs_session (host_id=? AND device_id=? AND session_id=? AND identity=?)"],
    [JOB_SQL, "sqlite_autoindex_wh_jobs_1 (id=?)"],
    [SENT_COUNT_SQL, "wh_jobs_session (host_id=? AND device_id=? AND session_id=?)"],
    [UNSENT_RECORDS_SQL, "wh_outbox_unsent"],
    [MOVE_JOB_SQL, "sqlite_autoindex_wh_jobs_1 (id=?)"],
    // A session by its key, or by the pairing's one open session: either is one row.
    [UPDATE_SESSION_SQL, "SEARCH wh_sessions USING"],
    [FINISH_SESSION_SQL, "SEARCH wh_sessions USING"],
    [DUE_SESSIONS_SQL, "wh_sessions_finished"],
    [PURGE_SESSION_SQL, "SEARCH wh_sessions USING"],
    [PURGE_JOBS_SQL, "wh_jobs_session (host_id=? AND device_id=? AND session_id=?)"],
    [PURGE_RECORDS_SQL, "wh_outbox_session (host_id=? AND device_id=? AND session_id=?)"],
  ];

  it("search an index, never a whole table", () => {
    const { db } = openLocalDb();
    const plan = (sql: string): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: sql.split("?").length - 1 }, () => "x"))
        .map((step) => String(step["detail"]));
    for (const [sql, index] of STATEMENTS) {
      expect(plan(sql).some((step) => step.includes(index)), `${sql}\n${plan(sql).join("\n")}`).toBe(true);
      // `json_each` (alias `r` in the receipt's `UPDATE … FROM`) is the batch's own list.
      expect(
        plan(sql).filter(
          (step) =>
            step.startsWith("SCAN ") && !step.includes("json_each") && !step.startsWith("SCAN r "),
        ),
        sql,
      ).toEqual([]);
    }
    expect(plan(JOB_BY_IDENTITY_SQL).filter((step) => step.includes("TEMP"))).toEqual([]);
  });

  it("are pinned on the shell's SQLite with the same texts", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    // The job reads are built from one column list in the Rust test (`let jobs = "…"`):
    // the list itself, then each read's tail after `{jobs}`.
    const columns =
      "SELECT id, session_id, kind, subject_id, identity, repair, reason, state, template_id, " +
      "template_rev, template_spec, fields, printer, bytes_base64, error_code, attempts, " +
      "operator_id, created_at, updated_at FROM wh_jobs";
    expect(source).toContain(`"${columns}"`);
    for (const sql of [OPEN_JOB_SQL, JOB_BY_IDENTITY_SQL, JOB_SQL]) {
      expect(sql.startsWith(columns), sql).toBe(true);
      expect(source).toContain(`{jobs}${sql.slice(columns.length)}`);
    }
    for (const [sql] of STATEMENTS.filter(([sql]) => !sql.startsWith(columns))) {
      expect(source, sql).toContain(`"${sql}"`);
    }
  });
});
```

`testModuleUrl` уже объявлен в начале файла (`const testModuleUrl = import.meta.url;`). Проверка колонок сравнивает текст `let jobs = "…"` Rust-теста; при расхождении пробелов поправить Rust-литерал (он должен склеиться в ту же строку).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-store.test.ts test/floor-schema.test.ts` — PASS.

- [ ] **Шаг 7: мутации** (порядок и откат — как в «Заметках»: `cp` в `/tmp/claude/before`, правка, ожидаемый FAIL, возврат, `cmp` молчит). (а) Из `FINISH_SESSION_SQL` убрать условие `AND NOT EXISTS (…)` (в TS и, чтобы тексты совпадали, только на время мутации) — FAIL `hold one waiting job per session, and no finish while it waits`. (б) В миграции `0012` удалить индекс `wh_jobs_open` — FAIL тот же тест (вторая вставка проходит). (в) В `DUE_SESSIONS_SQL` заменить `IS NOT 'accepted'` на `IS NULL` — FAIL `forget a finished session 30 days after its records were all accepted, and only then`. Каждую вернуть.

- [ ] **Шаг 8: коммит.** `cargo fmt … --check`; `git add apps/standalone/src-tauri/migrations/0012_warehouse_reprint.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src/floor/warehouse/warehouse-store.ts apps/standalone/test/support/warehouse.ts apps/standalone/test/warehouse-store.test.ts apps/standalone/test/floor-schema.test.ts`; сообщение `feat(standalone): station tables of the warehouse reprint, shell migration 0012 (plan СКЛ task 4)` + трейлер. Сообщить контроллеру: оболочка `0012` занята планом СКЛ.

---

## Задача 5: логика перепечатки (шаблоны, поиск, подготовка, отправка, исходы)

**Files:**

- Modify: `apps/standalone/src/floor/print/label-render.ts`
- Create: `apps/standalone/src/floor/warehouse/warehouse-templates.ts`, `apps/standalone/src/floor/warehouse/warehouse-work.ts`, `apps/standalone/test/warehouse-work.test.ts`

**Interfaces:**

- `renderLabel(spec, fields, printer, rasterize?, options?: { kmDataMatrix?: "native" | "raster" })`.
- `warehouse-templates.ts`: `KIND_PURPOSE`, `WarehouseTemplate`, `readWarehouseTemplates(local)`, `readOrgDefaults(local)`, `initialTemplates(templates, defaults)`, `isChoosable(template, kind)`, `checkTemplate(templates, chosenId, kind, chzProductGroupCode): TemplateCheck`.
- `warehouse-work.ts`: `RenderWarehouseLabel`, `WarehouseContext`, `readWarehouseScan(raw)`, `lookUp(ask, scan)`, `sourceFields(source)`, `prepareWarehouseJob`, `sendWarehouseJob(context, job, intent, operatorId)`, `verifyWarehouseJob`, `cancelWarehouseJob`, `recoverWarehouseJob`, `reprintScan(context, input): Promise<ScanOutcome>`, `WarehousePrinterError`, типы `ScanOutcome`, `PrepareRefusal`, `SendIntent`.

- [ ] **Шаг 1: `renderLabel` с `kmDataMatrix`.** В `apps/standalone/src/floor/print/label-render.ts` найти:

<!-- prettier-ignore -->
```ts
export async function renderLabel(
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  rasterize: RasterizeTextFn = rasterizeText,
): Promise<Uint8Array> {
  const { generateTspl, generateZpl } = await import("./label-emitters.js");
  const printSpec = withPrinterDpi(spec, printer.dpi);
  const text =
    printer.language === "tspl"
      ? await generateTspl(printSpec, fields, { rasterizeText: rasterize })
      : await generateZpl(printSpec, fields, { rasterizeText: rasterize });
  return latin1ToBytes(text);
}
```

и заменить на:

<!-- prettier-ignore -->
```ts
export async function renderLabel(
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  rasterize: RasterizeTextFn = rasterizeText,
  // A unit's code printed again (plan СКЛ) is drawn as the shared GS1 raster, as the
  // cloud's duplicate and the office's preview of a product duplicate draw it.
  options: { kmDataMatrix?: "native" | "raster" } = {},
): Promise<Uint8Array> {
  const { generateTspl, generateZpl } = await import("./label-emitters.js");
  const printSpec = withPrinterDpi(spec, printer.dpi);
  const text =
    printer.language === "tspl"
      ? await generateTspl(printSpec, fields, { rasterizeText: rasterize, ...options })
      : await generateZpl(printSpec, fields, { rasterizeText: rasterize, ...options });
  return latin1ToBytes(text);
}
```

(Если ДРВ уже влит и `renderLabel` ветвится по режиму принтера — добавить тот же параметр и передать его в ветку ZPL/TSPL; растровая ветка драйвера его не требует. Отклонение записать.)

- [ ] **Шаг 2: тест логики (RED).** Создать `apps/standalone/test/warehouse-work.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  cancelWarehouseJob,
  recoverWarehouseJob,
  reprintScan,
  sendWarehouseJob,
  sourceFields,
  verifyWarehouseJob,
  WarehousePrinterError,
  type WarehouseContext,
} from "../src/floor/warehouse/warehouse-work.js";
import {
  finishSession,
  readJob,
  startSession,
  type WarehouseSession,
} from "../src/floor/warehouse/warehouse-store.js";
import type { WarehouseLookup, WarehouseLookupResult } from "../src/host/protocol.js";
import { HostError } from "../src/host/client.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { manualRuntime, setUpPrinting } from "./support/printing.js";
import {
  BOX_SOURCE,
  BOX_SSCC,
  BOX_TEMPLATE,
  CODE_HASH,
  KM,
  PALLET_SOURCE,
  PALLET_SSCC,
  PALLET_TEMPLATE,
  seedWarehouseCopies,
  UNIT_SOURCE,
  UNIT_TEMPLATE,
  warehouseRender,
} from "./support/warehouse.js";

const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

/** A station with the copies, the Zebra for boxes and pallets, the TSC for units, and an open session. */
async function station(options: { operator?: boolean; printers?: boolean } = {}) {
  const { db, executor } = openLocalDb();
  seedWarehouseCopies(db, options.operator === undefined ? {} : { operator: options.operator });
  if (options.printers !== false) {
    await setUpPrinting(executor, { assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" } });
  }
  const shell = fakeHardware();
  const { runtime, expire } = manualRuntime(shell.hardware);
  let tick = Date.parse("2026-10-09T07:00:00.000Z");
  let id = 0;
  const context: WarehouseContext = {
    local: executor,
    pairing: PAIRING,
    runtime,
    now: () => new Date((tick += 1000)),
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    render: warehouseRender,
  };
  const session: WarehouseSession = await startSession(executor, PAIRING, {
    id: SESSION,
    reason: "damaged",
    templates: { unit: UNIT_TEMPLATE, box: BOX_TEMPLATE, pallet: PALLET_TEMPLATE },
    operatorId: OPERATOR_ID,
    at: "2026-10-09T07:00:00.000Z",
  });
  return { db, local: executor, shell, expire, context, session };
}

function answering(result: WarehouseLookupResult) {
  return vi.fn(async (_lookup: WarehouseLookup) => result);
}

function scan(
  at: Awaited<ReturnType<typeof station>>,
  raw: string,
  ask: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>,
  online = true,
) {
  return reprintScan(at.context, { session: at.session, raw, operatorId: OPERATOR_ID, online, ask });
}

function records(db: Awaited<ReturnType<typeof station>>["db"]): unknown[] {
  return rows(db, "SELECT payload FROM wh_outbox ORDER BY seq").map((row) =>
    JSON.parse(String(row["payload"])),
  );
}

describe("a label printed again from the warehouse (plan СКЛ)", () => {
  it("prints a box of another station found on the host, once, with its frozen fields", async () => {
    const at = await station();
    const ask = answering({ status: "found", source: BOX_SOURCE });
    const outcome = await scan(at, BOX_SSCC, ask);
    expect(ask).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(outcome).toMatchObject({ kind: "printed", repair: null, job: { state: "sent", kind: "box", identity: BOX_SSCC, attempts: 1 } });
    expect(at.shell.sends.map((send) => send.text)).toEqual([`^XA zpl 203 58x40 ${BOX_SSCC} native ^XZ`]);
    expect(records(at.db)).toEqual([
      expect.objectContaining({ subjectKind: "box", subjectId: BOX_SOURCE.subjectId, identity: BOX_SSCC, reasonCode: "damaged", outcome: "sent", errorCode: null, attempt: 1, operatorId: OPERATOR_ID, templateId: BOX_TEMPLATE, templateRev: 4 }),
    ]);
    // The same code again in the session is not printed by itself.
    const again = await scan(at, BOX_SSCC, ask);
    expect(again).toMatchObject({ kind: "duplicate", job: { state: "sent" } });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(at.shell.sends).toHaveLength(1);
  });

  it("finds the box of an old !1 label under its own SSCC and prints the corrected label", async () => {
    const at = await station();
    const ask = answering({ status: "found", source: BOX_SOURCE });
    const outcome = await scan(at, `]C1!100${BOX_SSCC}`, ask);
    expect(ask).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(outcome).toMatchObject({ kind: "printed", repair: "legacy_tspl_fnc1_literal" });
    expect(records(at.db)).toEqual([expect.objectContaining({ repair: "legacy_tspl_fnc1_literal" })]);
    // The correct form of the same SSCC is the same label in the session.
    expect(await scan(at, BOX_SSCC, ask)).toMatchObject({ kind: "duplicate" });
  });

  it("prints a unit's full code as the GS1 raster on the duplicate printer, and a pallet on its own", async () => {
    const at = await station();
    const unit = await scan(at, KM, answering({ status: "found", source: UNIT_SOURCE }));
    expect(unit).toMatchObject({ kind: "printed", job: { kind: "unit", identity: CODE_HASH } });
    if (unit.kind !== "printed") throw new Error("printed");
    expect(unit.job.fields["km.code"]).toBe(KM);
    expect(unit.job.fields.qty).toBe("1");
    const pallet = await scan(at, PALLET_SSCC, answering({ status: "found", source: PALLET_SOURCE }));
    expect(pallet).toMatchObject({ kind: "printed", job: { kind: "pallet" } });
    expect(at.shell.sends.map((send) => send.text)).toEqual([
      "^XA tspl 300 58x40 km raster ^XZ",
      expect.stringContaining(`${PALLET_SSCC} native`),
    ]);
    expect(at.shell.sends[0]?.target).toEqual({ kind: "serial", port: "COM4", baud: 9600 });
  });

  it("takes the label's dates from the record, not from today", () => {
    const fields = sourceFields(BOX_SOURCE);
    expect(fields.date).toBe("08.10.2026");
    expect(fields.expiry).toBe("17.10.2026");
    expect(fields.qty).toBe("12");
    expect(fields["shift.no"]).toBe("OCT26-003");
    expect(fields["counterparty.name"]).toBe("ООО «Север»");
  });

  it("says why nothing was printed: offline, not found, unavailable, an old host, a restore", async () => {
    const at = await station();
    const never = vi.fn(async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }));
    expect(await scan(at, BOX_SSCC, never, false)).toEqual({ kind: "offline" });
    expect(never).not.toHaveBeenCalled();
    expect(await scan(at, BOX_SSCC, never)).toEqual({ kind: "not_found" });
    expect(await scan(at, BOX_SSCC, answering({ status: "unavailable", reason: "disassembled" }))).toEqual({ kind: "unavailable", reason: "disassembled" });
    const failing = (error: HostError) => vi.fn(async (): Promise<WarehouseLookupResult> => { throw error; });
    expect(await scan(at, BOX_SSCC, failing(new HostError({ kind: "transport", code: "unreachable", message: "x" })))).toEqual({ kind: "offline" });
    expect(await scan(at, BOX_SSCC, failing(new HostError({ kind: "api", code: "not_found", status: 404, message: "x" })))).toEqual({ kind: "host_outdated" });
    expect(await scan(at, BOX_SSCC, failing(new HostError({ kind: "api", code: "restore_pending", status: 503, message: "x" })))).toEqual({ kind: "restore_pending" });
    expect(await scan(at, "hello", never)).toEqual({ kind: "invalid_scan" });
    expect(await scan(at, `!1!100${BOX_SSCC}`, never)).toEqual({ kind: "invalid_scan" });
    expect(at.shell.sends).toHaveLength(0);
    expect(records(at.db)).toEqual([]);
  });

  it("prints nothing for a code without its crypto tail, a missing template or an operator turned off", async () => {
    const at = await station();
    const bare = { ...UNIT_SOURCE, canonical: "010460068200001321S000001" };
    expect(await scan(at, KM, answering({ status: "found", source: bare }))).toEqual({ kind: "refused", reason: "incomplete_km" });
    const noPallet = await station();
    noPallet.db.prepare("UPDATE wh_sessions SET pallet_template_id = NULL").run();
    noPallet.session = { ...noPallet.session, templates: { ...noPallet.session.templates, pallet: null } };
    expect(await scan(noPallet, PALLET_SSCC, answering({ status: "found", source: PALLET_SOURCE }))).toEqual({ kind: "refused", reason: "no_template" });
    noPallet.db.prepare("UPDATE ref_templates SET enabled = 0 WHERE id = ?").run(BOX_TEMPLATE);
    expect(await scan(noPallet, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }))).toEqual({ kind: "refused", reason: "template_unavailable" });
    const nobody = await station({ operator: false });
    expect(await scan(nobody, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }))).toEqual({ kind: "refused", reason: "operator_denied" });
    for (const s of [at, noPallet, nobody]) expect(s.shell.sends).toHaveLength(0);
  });

  it("keeps a job with no printer failed, retries it once a printer is set, or cancels it", async () => {
    const at = await station({ printers: false });
    const outcome = await scan(at, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    expect(outcome).toMatchObject({ kind: "printed", job: { state: "failed", errorCode: "printer_unconfigured", attempts: 0 } });
    if (outcome.kind !== "printed") throw new Error("printed");
    // Another code waits: the session takes none while this one is not decided.
    expect(await scan(at, PALLET_SSCC, answering({ status: "found", source: PALLET_SOURCE }))).toMatchObject({ kind: "busy" });
    await expect(sendWarehouseJob(at.context, outcome.job, { kind: "retry" }, OPERATOR_ID)).rejects.toBeInstanceOf(WarehousePrinterError);
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    const sent = await sendWarehouseJob(at.context, outcome.job, { kind: "retry" }, OPERATOR_ID);
    expect(sent).toMatchObject({ state: "sent", attempts: 1 });
    const cancelling = await station({ printers: false });
    const failed = await scan(cancelling, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    if (failed.kind !== "printed") throw new Error("printed");
    expect(await cancelWarehouseJob(cancelling.context, failed.job, OPERATOR_ID)).toMatchObject({ state: "cancelled" });
    expect(records(cancelling.db).map((record) => (record as { outcome: string }).outcome)).toEqual(["failed", "cancelled"]);
    expect(await finishSession(cancelling.local, PAIRING, SESSION, OPERATOR_ID, "2026-10-09T08:00:00.000Z")).toBe("finished");
  });

  it("never sends an unknown label again by itself: a scan of the new label or a new attempt with a reason", async () => {
    const at = await station();
    at.shell.holdSends();
    const pending = scan(at, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    await vi.waitFor(() => expect(at.shell.heldSends()).toBe(1));
    at.expire();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "printed", job: { state: "unknown", errorCode: "timeout" } });
    if (outcome.kind !== "printed") throw new Error("printed");
    at.shell.releaseSend({ sent: true });
    expect(await finishSession(at.local, PAIRING, SESSION, OPERATOR_ID, "2026-10-09T08:00:00.000Z")).toBe("busy");
    // The old !1 label never checks the corrected one; another SSCC is a mismatch.
    expect(await verifyWarehouseJob(at.context, outcome.job, `!100${BOX_SSCC}`, OPERATOR_ID)).toEqual({ kind: "invalid" });
    expect(await verifyWarehouseJob(at.context, outcome.job, PALLET_SSCC, OPERATOR_ID)).toEqual({ kind: "mismatch" });
    const again = await sendWarehouseJob(at.context, outcome.job, { kind: "again", reason: "lost" }, OPERATOR_ID);
    expect(again).toMatchObject({ state: "sent", attempts: 2, reason: "lost" });
    expect(at.shell.sends).toHaveLength(2);
    expect(await verifyWarehouseJob(at.context, again, BOX_SSCC, OPERATOR_ID)).toMatchObject({ kind: "verified", job: { state: "verified" } });
    expect(records(at.db).map((record) => { const r = record as { outcome: string; attempt: number; reasonCode: string; errorCode: string | null }; return [r.outcome, r.attempt, r.reasonCode, r.errorCode]; })).toEqual([
      ["unknown", 1, "damaged", "timeout"],
      ["sent", 2, "lost", null],
      ["verified", 2, "lost", null],
    ]);
  });

  it("finds a send cut by a restart unknown, and leaves one still in flight alone", async () => {
    const at = await station();
    const printed = await scan(at, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    if (printed.kind !== "printed") throw new Error("printed");
    // As if the app stopped right after writing `sending`.
    at.db.prepare("UPDATE wh_jobs SET state = 'sending' WHERE id = ?").run(printed.job.id);
    const flying: WarehouseContext = {
      ...at.context,
      runtime: { ...at.context.runtime, isInFlight: () => true },
    };
    expect(await recoverWarehouseJob(flying, SESSION, OPERATOR_ID)).toMatchObject({ state: "sending" });
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toMatchObject({
      state: "unknown",
      errorCode: "interrupted",
    });
    expect((await readJob(at.local, PAIRING, printed.job.id))?.attempts).toBe(1);
    expect(records(at.db).map((record) => (record as { outcome: string }).outcome)).toEqual(["sent", "unknown"]);
    // Nothing went to the printer again.
    expect(at.shell.sends).toHaveLength(1);
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-work.test.ts` — FAIL (модулей нет).

- [ ] **Шаг 3: шаблоны.** Создать `apps/standalone/src/floor/warehouse/warehouse-templates.ts`:

<!-- prettier-ignore -->
```ts
import {
  assertDuplicateTemplate,
  DomainError,
  labelTemplateSpecSchema,
  labelTemplateUsesField,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { z } from "zod";

import type { TemplatePurpose, WarehouseSubjectKind } from "../../host/protocol.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { WarehouseTemplates } from "./warehouse-store.js";

/** The template purpose of each kind of label printed again. */
export const KIND_PURPOSE: Record<WarehouseSubjectKind, TemplatePurpose> = {
  unit: "product_duplicate",
  box: "box",
  pallet: "pallet",
};

/** A template of the copies, with its layout read (`null` — it does not read). */
export interface WarehouseTemplate {
  id: string;
  name: string;
  purpose: TemplatePurpose;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
  rev: number;
  spec: LabelTemplateSpec | null;
}

const templateRow = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.enum(["box", "pallet", "product_duplicate"]),
  enabled: z.number(),
  category_codes: z.string().nullable(),
  spec: z.string(),
  rev: z.number().int(),
});
const codesSchema = z.array(z.number().int());
const orgRow = z.object({
  default_duplicate_template_id: z.string().nullable(),
  default_box_template_id: z.string().nullable(),
  default_pallet_template_id: z.string().nullable(),
});

function readJson<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The templates of the three purposes in this pairing's copies, by name (the reference table is small). */
export async function readWarehouseTemplates(local: LocalExecutor): Promise<WarehouseTemplate[]> {
  const found = await local.query(
    "SELECT id, name, purpose, enabled, category_codes, spec, rev FROM ref_templates " +
      "WHERE purpose IN ('product_duplicate', 'box', 'pallet') ORDER BY name, id",
    [],
    templateRow,
  );
  return found.map((row) => ({
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    enabled: row.enabled === 1,
    chzProductGroupCodes:
      row.category_codes === null ? null : readJson(row.category_codes, codesSchema),
    rev: row.rev,
    spec: readJson(row.spec, labelTemplateSpecSchema),
  }));
}

/** The organization's default template of each kind (`ref_org`), or none. */
export async function readOrgDefaults(local: LocalExecutor): Promise<WarehouseTemplates> {
  const [org] = await local.query(
    "SELECT default_duplicate_template_id, default_box_template_id, default_pallet_template_id " +
      "FROM ref_org",
    [],
    orgRow,
  );
  return {
    unit: org?.default_duplicate_template_id ?? null,
    box: org?.default_box_template_id ?? null,
    pallet: org?.default_pallet_template_id ?? null,
  };
}

/** A template the operator may choose for `kind`: of its purpose, enabled, with a layout that reads. */
export function isChoosable(template: WarehouseTemplate, kind: WarehouseSubjectKind): boolean {
  return template.purpose === KIND_PURPOSE[kind] && template.enabled && template.spec !== null;
}

/**
 * The templates a new session starts with (decision Р8): the organization's default
 * when it is choosable, otherwise the only choosable one, otherwise none.
 */
export function initialTemplates(
  templates: readonly WarehouseTemplate[],
  defaults: WarehouseTemplates,
): WarehouseTemplates {
  const pick = (kind: WarehouseSubjectKind): string | null => {
    const choosable = templates.filter((template) => isChoosable(template, kind));
    const preferred = choosable.find((template) => template.id === defaults[kind]);
    if (preferred !== undefined) return preferred.id;
    const [only, ...others] = choosable;
    return only !== undefined && others.length === 0 ? only.id : null;
  };
  return { unit: pick("unit"), box: pick("box"), pallet: pick("pallet") };
}

/** Whether the chosen template prints this record, and why not. */
export type TemplateCheck =
  | { kind: "ok"; template: WarehouseTemplate; spec: LabelTemplateSpec }
  | { kind: "no_template" }
  | { kind: "template_unavailable" }
  | { kind: "template_unfit" };

/**
 * The chosen template of `kind` for a record of product group `group`: chosen,
 * still enabled with a readable layout, covering the group, and a layout of its
 * purpose — a unit's with its one GS1 DataMatrix of the full code and no SSCC, a
 * box's or a pallet's with the SSCC and no unit code. No other template is put
 * in its place (decision Р8).
 */
export function checkTemplate(
  templates: readonly WarehouseTemplate[],
  chosenId: string | null,
  kind: WarehouseSubjectKind,
  group: number | null,
): TemplateCheck {
  if (chosenId === null) return { kind: "no_template" };
  const template = templates.find((candidate) => candidate.id === chosenId);
  if (template === undefined || !isChoosable(template, kind) || template.spec === null) {
    return { kind: "template_unavailable" };
  }
  const purpose = KIND_PURPOSE[kind];
  if (!templateFitsSlot(template, { purpose, chzProductGroupCode: group })) {
    return { kind: "template_unfit" };
  }
  const { spec } = template;
  if (kind === "unit") {
    try {
      assertDuplicateTemplate(spec);
    } catch (error) {
      if (error instanceof DomainError) return { kind: "template_unfit" };
      throw error;
    }
  } else if (!labelTemplateUsesField(spec, "sscc") || labelTemplateUsesField(spec, "km.code")) {
    return { kind: "template_unfit" };
  }
  return { kind: "ok", template, spec };
}
```

- [ ] **Шаг 4: работа.** Создать `apps/standalone/src/floor/warehouse/warehouse-work.ts`:

<!-- prettier-ignore -->
```ts
import {
  boxLabelFields,
  compareWarehouseReprintLabel,
  DomainError,
  labelTemplateSpecSchema,
  palletLabelFields,
  parseDuplicateKm,
  resolveWarehouseReprintScan,
  type LabelTemplateSpec,
} from "@markiro/domain";

import { shellActionFor } from "../../app/shell.js";
import { bytesToBase64 } from "../../hardware/hardware.js";
import { HostError } from "../../host/client.js";
import type {
  WarehouseLookup,
  WarehouseLookupResult,
  WarehouseSource,
  WarehouseSubjectKind,
} from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { renderLabel, type LabelFields, type LabelPrinter } from "../print/label-render.js";
import { base64ToBytes, settleOutcome } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import {
  readWorkstationSettings,
  resolvePrinter,
  type PrintPurpose,
  type PrinterProfile,
} from "../setup/workstation-settings.js";
import { readOperatorCopy } from "../sign-in.js";
import { checkTemplate, readWarehouseTemplates } from "./warehouse-templates.js";
import {
  insertJobStatement,
  moveJobStatement,
  readJob,
  readJobByIdentity,
  readOpenJob,
  recordStatement,
  StaleWarehouseError,
  warehouseRecord,
  type JobMove,
  type NewWarehouseJob,
  type WarehouseJob,
  type WarehouseOutcome,
  type WarehouseReason,
  type WarehouseRepair,
  type WarehouseSession,
} from "./warehouse-store.js";

/** How a label printed again is rendered: `renderLabel` by default, a test's own otherwise. */
export type RenderWarehouseLabel = (
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  options: { kmDataMatrix?: "native" | "raster" },
) => Promise<Uint8Array>;

const defaultRender: RenderWarehouseLabel = (spec, fields, printer, options) =>
  renderLabel(spec, fields, printer, undefined, options);

/** What the warehouse work needs: the database, the pairing, the printers, a clock, ids. */
export interface WarehouseContext {
  local: LocalExecutor;
  pairing: Pairing;
  runtime: PrintRuntime;
  now: () => Date;
  newId: () => string;
  render?: RenderWarehouseLabel;
}

/** The printer purpose of each kind (decision Р14). */
const PRINT_PURPOSE: Record<WarehouseSubjectKind, PrintPurpose> = {
  unit: "duplicate",
  box: "box",
  pallet: "pallet",
};

/** A unit's code is drawn as the GS1 raster; a box's and a pallet's barcodes natively. */
function renderOptions(kind: WarehouseSubjectKind): { kmDataMatrix?: "raster" } {
  return kind === "unit" ? { kmDataMatrix: "raster" } : {};
}

/** A retry or a new attempt has no printer for its kind, or its label does not render for it. */
export class WarehousePrinterError extends Error {
  readonly code: "printer_unconfigured" | "render_failed";
  constructor(code: "printer_unconfigured" | "render_failed") {
    super(`warehouse print: ${code}`);
    this.name = "WarehousePrinterError";
    this.code = code;
  }
}

/** A job that cannot take this action in its state. */
export class WarehouseStateError extends Error {
  constructor(id: string, state: string) {
    super(`warehouse job ${id} cannot do this from ${state}`);
    this.name = "WarehouseStateError";
  }
}

/** What a scan of the warehouse mode asks: a code's hash or an SSCC (a legacy `!1` label repaired). */
export type WarehouseScan =
  | { kind: "code"; codeHash: string }
  | { kind: "sscc"; sscc: string; repair: WarehouseRepair | null }
  | { kind: "invalid" };

/** The domain's warehouse rule (`resolveWarehouseReprintScan`): strict, `!1` only before an SSCC. */
export function readWarehouseScan(raw: string): WarehouseScan {
  const scan = resolveWarehouseReprintScan(raw);
  if (scan.kind === "unit") return { kind: "code", codeHash: scan.codeHash };
  if (scan.kind === "box") return { kind: "sscc", sscc: scan.sscc, repair: scan.repair };
  return { kind: "invalid" };
}

/** How the host answered a lookup, or why it did not. */
export type LookupAnswer =
  | { kind: "found"; source: WarehouseSource }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: "released" | "disassembled" }
  | { kind: "offline" }
  | { kind: "host_outdated" }
  | { kind: "restore_pending" }
  | { kind: "lookup_failed" }
  | { kind: "host_error"; error: unknown };

/**
 * Asks the host (decision Р2). A transport failure is `offline` — never «not found»;
 * a host without the route (`not_found`) is too old; a restored host holds the
 * route; a refused key or a changed certificate is the shell's (`host_error`).
 */
export async function lookUp(
  ask: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>,
  scan: Exclude<WarehouseScan, { kind: "invalid" }>,
): Promise<LookupAnswer> {
  const identity = scan.kind === "code" ? scan.codeHash : scan.sscc;
  try {
    const result = await ask(scan.kind === "code" ? { codeHash: scan.codeHash } : { sscc: scan.sscc });
    if (result.status === "found") {
      // An answer for something else is no answer for this label.
      return result.source.identity === identity
        ? { kind: "found", source: result.source }
        : { kind: "lookup_failed" };
    }
    if (result.status === "not_found") return { kind: "not_found" };
    return { kind: "unavailable", reason: result.reason };
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "host_error", error };
    if (error instanceof HostError) {
      if (error.kind === "transport") {
        return error.code === "invalid_response" ? { kind: "lookup_failed" } : { kind: "offline" };
      }
      if (error.code === "not_found") return { kind: "host_outdated" };
      if (error.code === "restore_pending") return { kind: "restore_pending" };
    }
    return { kind: "lookup_failed" };
  }
}

/** A unit whose stored code has no crypto tail, or another product's code. */
export class IncompleteCodeError extends Error {
  constructor() {
    super("the stored code cannot be printed");
    this.name = "IncompleteCodeError";
  }
}

/**
 * The label's fields from the host's record (decision Р15): the shift's product,
 * counterparty, number and production date, the record's own instant — so the
 * production and expiry dates are the historical ones — its counts and operator.
 * A unit's label carries its full canonical code (`parseDuplicateKm` refuses one
 * without a crypto tail) and a quantity of one, as the cloud's duplicate.
 */
export function sourceFields(source: WarehouseSource): LabelFields {
  const base = {
    productName: source.product.name,
    productPrintName: source.product.printName,
    gtin14: source.product.gtin14,
    egaisCode: null,
    shelfLifeDays: source.product.shelfLifeDays,
    operatorName: source.operatorName,
    counterpartyName: source.counterpartyName,
    closedAt: source.at,
    productionDate: source.productionDate,
    shiftNumber: source.shiftNumber,
  };
  if (source.kind === "unit") {
    const km = parseDuplicateKm(source.canonical ?? "");
    if (km.gtin14 !== source.product.gtin14) throw new IncompleteCodeError();
    return { ...boxLabelFields({ ...base, sscc: "", itemCount: 1 }), "km.code": km.raw, qty: "1", sscc: "" };
  }
  const sscc = source.sscc ?? "";
  if (source.kind === "box") return boxLabelFields({ ...base, sscc, itemCount: source.itemCount });
  return palletLabelFields({
    ...base,
    sscc,
    boxCount: source.boxCount ?? 0,
    itemCount: source.itemCount,
  });
}

/** Why a found record was not made into a job. */
export type PrepareRefusal =
  | "incomplete_km"
  | "no_template"
  | "template_unavailable"
  | "template_unfit"
  | "operator_denied"
  | "busy";

export type PrepareResult = { kind: "job"; job: WarehouseJob } | { kind: "refused"; reason: PrepareRefusal };

/**
 * Makes the job of a found record (decisions Р8, Р13, Р14): the operator checked
 * against the copies as they are now, the label's fields, the session's template
 * of the kind checked, the printer of the kind, the bytes rendered for it. One
 * transaction writes the job — `prepared`, or `failed` with its reason (and that
 * attempt's record) when no printer is assigned or the label does not render.
 */
export async function prepareWarehouseJob(
  context: WarehouseContext,
  input: { session: WarehouseSession; source: WarehouseSource; repair: WarehouseRepair | null; operatorId: string },
): Promise<PrepareResult> {
  const { local, pairing } = context;
  const { session, source } = input;
  const copy = await readOperatorCopy(
    { local, pairing, now: () => context.now().getTime() },
    input.operatorId,
  );
  if (copy.kind !== "present") return { kind: "refused", reason: "operator_denied" };
  let fields: LabelFields;
  try {
    fields = sourceFields(source);
  } catch (error) {
    if (error instanceof DomainError || error instanceof IncompleteCodeError) {
      return { kind: "refused", reason: "incomplete_km" };
    }
    throw error;
  }
  const check = checkTemplate(
    await readWarehouseTemplates(local),
    session.templates[source.kind],
    source.kind,
    source.product.chzProductGroupCode,
  );
  if (check.kind !== "ok") return { kind: "refused", reason: check.kind };
  if ((await readOpenJob(local, pairing, session.id)) !== null) {
    return { kind: "refused", reason: "busy" };
  }
  const printer = resolvePrinter(await readWorkstationSettings(local), PRINT_PURPOSE[source.kind]);
  let bytes: string | null = null;
  let error: "printer_unconfigured" | "render_failed" | null =
    printer === null ? "printer_unconfigured" : null;
  if (printer !== null) {
    try {
      bytes = bytesToBase64(
        await (context.render ?? defaultRender)(check.spec, fields, printer, renderOptions(source.kind)),
      );
    } catch {
      error = "render_failed";
    }
  }
  const at = context.now().toISOString();
  const job: NewWarehouseJob = {
    id: context.newId(),
    sessionId: session.id,
    kind: source.kind,
    subjectId: source.subjectId,
    identity: source.identity,
    repair: input.repair,
    reason: session.reason,
    state: error === null ? "prepared" : "failed",
    templateId: check.template.id,
    templateRev: check.template.rev,
    templateSpec: JSON.stringify(check.spec),
    fields,
    printer: bytes === null ? null : printer,
    bytesBase64: bytes,
    errorCode: error,
    operatorId: input.operatorId,
    createdAt: at,
  };
  await local.transaction([
    insertJobStatement(pairing, job),
    ...(error === null
      ? []
      : [
          recordStatement(
            pairing,
            warehouseRecord(job, {
              id: context.newId(),
              attempt: 0,
              reason: session.reason,
              outcome: "failed",
              errorCode: error,
              operatorId: input.operatorId,
              occurredAt: at,
            }),
            at,
          ),
        ]),
  ]);
  const stored = await readJob(local, pairing, job.id);
  if (stored === null) throw new StaleWarehouseError(job.id);
  return { kind: "job", job: stored };
}

/** Which send: the first of a prepared job, a retry of a failed one, a new attempt with a reason. */
export type SendIntent = { kind: "first" } | { kind: "retry" } | { kind: "again"; reason: WarehouseReason };

const SEND_FROM: Record<SendIntent["kind"], readonly WarehouseJob["state"][]> = {
  first: ["prepared"],
  retry: ["failed"],
  again: ["sent", "verified", "unknown"],
};

async function moveAndRecord(
  context: WarehouseContext,
  job: WarehouseJob,
  move: JobMove,
  outcome: WarehouseOutcome,
  operatorId: string,
): Promise<WarehouseJob> {
  const { local, pairing } = context;
  const at = context.now().toISOString();
  try {
    await local.transaction([
      moveJobStatement(pairing, job, move, at),
      recordStatement(
        pairing,
        warehouseRecord(job, {
          id: context.newId(),
          attempt: move.attempts,
          reason: move.reason,
          outcome,
          errorCode: move.errorCode,
          operatorId,
          occurredAt: at,
        }),
        at,
      ),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleWarehouseError(job.id);
    }
    throw error;
  }
  const after = await readJob(local, pairing, job.id);
  if (after === null) throw new StaleWarehouseError(job.id);
  return after;
}

/**
 * Sends a job (decisions Р11, Р14). `sending` and one more attempt are written
 * before the bytes go — with the new printer and bytes of a retry or a new
 * attempt — so a crash in between leaves `sending`, which the next opening reads
 * as `unknown`. Then one send through the runtime and one write of where it
 * ended with that attempt's record: `sent` only on the shell's `{ sent: true }`.
 * A retry or a new attempt prints on the printer assigned now; the label is
 * rendered again from the frozen template and fields only when that printer's
 * language or resolution differs from the bytes' (a retry of a job with no bytes
 * always renders). Nothing here sends again by itself.
 */
export async function sendWarehouseJob(
  context: WarehouseContext,
  job: WarehouseJob,
  intent: SendIntent,
  operatorId: string,
): Promise<WarehouseJob> {
  const { local, pairing } = context;
  if (!SEND_FROM[intent.kind].includes(job.state)) throw new WarehouseStateError(job.id, job.state);
  let printer: PrinterProfile | null = job.printer;
  let bytes = job.bytesBase64;
  if (intent.kind !== "first") {
    const assigned = resolvePrinter(await readWorkstationSettings(local), PRINT_PURPOSE[job.kind]);
    if (assigned === null) throw new WarehousePrinterError("printer_unconfigured");
    if (
      bytes === null ||
      printer === null ||
      printer.language !== assigned.language ||
      printer.dpi !== assigned.dpi
    ) {
      const spec = labelTemplateSpecSchema.safeParse(JSON.parse(job.templateSpec));
      if (!spec.success) throw new WarehousePrinterError("render_failed");
      try {
        bytes = bytesToBase64(
          await (context.render ?? defaultRender)(spec.data, job.fields, assigned, renderOptions(job.kind)),
        );
      } catch {
        throw new WarehousePrinterError("render_failed");
      }
    }
    printer = assigned;
  }
  if (printer === null || bytes === null) throw new WarehouseStateError(job.id, job.state);
  const attempt = job.attempts + 1;
  const reason = intent.kind === "again" ? intent.reason : job.reason;
  try {
    await local.transaction([
      moveJobStatement(
        pairing,
        job,
        { state: "sending", errorCode: null, attempts: attempt, reason, printer, bytesBase64: bytes },
        context.now().toISOString(),
      ),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleWarehouseError(job.id);
    }
    throw error;
  }
  const outcome = await context.runtime.send(job.id, printer.target, base64ToBytes(bytes));
  const settled = settleOutcome(outcome);
  const sending: WarehouseJob = {
    ...job,
    state: "sending",
    attempts: attempt,
    reason,
    printer,
    bytesBase64: bytes,
    errorCode: null,
  };
  return moveAndRecord(
    context,
    sending,
    {
      state: settled.state,
      errorCode: settled.state === "sent" ? null : settled.code,
      attempts: attempt,
      reason,
      printer,
      bytesBase64: bytes,
    },
    settled.state,
    operatorId,
  );
}

/**
 * Checks a sent or unknown label by a scan of the new label (decision Р11): the
 * domain's strict comparison — the old `!1` label is `invalid`, never a match.
 */
export async function verifyWarehouseJob(
  context: WarehouseContext,
  job: WarehouseJob,
  raw: string,
  operatorId: string,
): Promise<{ kind: "verified"; job: WarehouseJob } | { kind: "mismatch" } | { kind: "invalid" }> {
  if (job.state !== "sent" && job.state !== "unknown") throw new WarehouseStateError(job.id, job.state);
  const expected =
    job.kind === "unit"
      ? { kind: "unit" as const, canonicalRaw: job.fields["km.code"] }
      : { kind: "box" as const, sscc: job.identity };
  const answer = compareWarehouseReprintLabel(expected, raw);
  if (answer !== "match") return { kind: answer };
  const verified = await moveAndRecord(
    context,
    job,
    { state: "verified", errorCode: null, attempts: job.attempts, reason: job.reason, printer: job.printer, bytesBase64: job.bytesBase64 },
    "verified",
    operatorId,
  );
  return { kind: "verified", job: verified };
}

/** Cancels a failed job: nothing left this computer, so nothing may exist. */
export async function cancelWarehouseJob(
  context: WarehouseContext,
  job: WarehouseJob,
  operatorId: string,
): Promise<WarehouseJob> {
  if (job.state !== "failed") throw new WarehouseStateError(job.id, job.state);
  return moveAndRecord(
    context,
    job,
    { state: "cancelled", errorCode: null, attempts: job.attempts, reason: job.reason, printer: job.printer, bytesBase64: job.bytesBase64 },
    "cancelled",
    operatorId,
  );
}

/**
 * The session's waiting job when the screen opens: one found in `sending` whose
 * bytes no send of this app holds is `unknown` (`interrupted`) — the app stopped
 * after the bytes may have gone. Run only from the screen's work queue, never
 * beside a send of it.
 */
export async function recoverWarehouseJob(
  context: WarehouseContext,
  sessionId: string,
  operatorId: string,
): Promise<WarehouseJob | null> {
  const job = await readOpenJob(context.local, context.pairing, sessionId);
  if (job === null || job.state !== "sending" || context.runtime.isInFlight(job.id)) return job;
  return moveAndRecord(
    context,
    job,
    { state: "unknown", errorCode: "interrupted", attempts: job.attempts, reason: job.reason, printer: job.printer, bytesBase64: job.bytesBase64 },
    "unknown",
    operatorId,
  );
}

/** What a scan of the warehouse mode came to. */
export type ScanOutcome =
  | { kind: "invalid_scan" }
  | { kind: "busy"; job: WarehouseJob }
  | { kind: "duplicate"; job: WarehouseJob }
  | { kind: "offline" }
  | { kind: "host_outdated" }
  | { kind: "restore_pending" }
  | { kind: "lookup_failed" }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: "released" | "disassembled" }
  | { kind: "host_error"; error: unknown }
  | { kind: "refused"; reason: PrepareRefusal }
  | { kind: "printed"; job: WarehouseJob; repair: WarehouseRepair | null };

/**
 * One scan (or a typed code) of the warehouse mode: read by the domain's warehouse
 * rule; refused while a job of the session waits; a code the session printed is a
 * `duplicate` (no host, no print); without the link nothing is looked up
 * (`offline`); otherwise the host finds the record, the job is made and, prepared,
 * sent once. Run from the screen's work queue, one scan at a time.
 */
export async function reprintScan(
  context: WarehouseContext,
  input: {
    session: WarehouseSession;
    raw: string;
    operatorId: string;
    online: boolean;
    ask: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  },
): Promise<ScanOutcome> {
  const { local, pairing } = context;
  const scan = readWarehouseScan(input.raw);
  if (scan.kind === "invalid") return { kind: "invalid_scan" };
  const waiting = await readOpenJob(local, pairing, input.session.id);
  if (waiting !== null) return { kind: "busy", job: waiting };
  const identity = scan.kind === "code" ? scan.codeHash : scan.sscc;
  const earlier = await readJobByIdentity(local, pairing, input.session.id, identity);
  if (earlier !== null) return { kind: "duplicate", job: earlier };
  if (!input.online) return { kind: "offline" };
  const answer = await lookUp(input.ask, scan);
  if (answer.kind !== "found") return answer;
  const repair = scan.kind === "sscc" ? scan.repair : null;
  const prepared = await prepareWarehouseJob(context, {
    session: input.session,
    source: answer.source,
    repair,
    operatorId: input.operatorId,
  });
  if (prepared.kind === "refused") return prepared;
  const job =
    prepared.job.state === "prepared"
      ? await sendWarehouseJob(context, prepared.job, { kind: "first" }, input.operatorId)
      : prepared.job;
  return { kind: "printed", job, repair };
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-work.test.ts` — PASS; `typecheck`, `lint` — чисто (форматирование длинных строк — `prettier --write` на новые файлы).

- [ ] **Шаг 5: мутации.** (а) В `reprintScan` убрать проверку `earlier` — FAIL «prints a box of another station…» (вторая печать). (б) В `sendWarehouseJob` писать `sending` после `runtime.send` (переставить) — FAIL «finds a send cut by a restart unknown…» (или «never sends an unknown…»). (в) В `lookUp` вернуть `not_found` для транспортной ошибки — FAIL «says why nothing was printed…». Каждую вернуть.

- [ ] **Шаг 6: коммит.** `git add apps/standalone/src/floor/print/label-render.ts apps/standalone/src/floor/warehouse/warehouse-templates.ts apps/standalone/src/floor/warehouse/warehouse-work.ts apps/standalone/test/warehouse-work.test.ts`; сообщение `feat(standalone): warehouse reprint work — lookup, frozen job, one send, no automatic resend (plan СКЛ task 5)` + трейлер.

---

## Задача 6: доставка записей на хост и хранение

**Files:**

- Create: `apps/standalone/src/local/warehouse-sender.ts`, `apps/standalone/test/warehouse-sender.test.ts`
- Modify: `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/test/floor-schema.test.ts`

**Interfaces:** `sendWarehouseBatch(local, pairing, send, now): Promise<SendResult>`, `WAREHOUSE_UNSENT_SQL`, `WAREHOUSE_ATTEMPT_SQL`, `WAREHOUSE_RECEIPT_SQL`, `MAX_WAREHOUSE_BATCH = 100`; `HostLinkOptions.sendWarehouseRecords?`.

- [ ] **Шаг 1: тест отправителя (RED).** Создать `apps/standalone/test/warehouse-sender.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { ReceiptMismatchError } from "../src/local/facts-sender.js";
import { sendWarehouseBatch } from "../src/local/warehouse-sender.js";
import { recordStatement, warehouseRecord } from "../src/floor/warehouse/warehouse-store.js";
import type { FactReceipt } from "../src/host/protocol.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { BOX_SSCC, BOX_TEMPLATE } from "./support/warehouse.js";

const AT = "2026-10-09T07:00:00.000Z";
const JOB = {
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  sessionId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  kind: "box" as const,
  subjectId: "b0000000-0000-4000-8000-000000000001",
  identity: BOX_SSCC,
  repair: null,
  templateId: BOX_TEMPLATE,
  templateRev: 4,
};

function record(n: number) {
  return warehouseRecord(JOB, {
    id: `6e7f8a9b-0c1d-4e2f-8a3b-${String(n).padStart(12, "0")}`,
    attempt: n,
    reason: "damaged",
    outcome: "sent",
    errorCode: null,
    operatorId: OPERATOR_ID,
    occurredAt: AT,
  });
}

describe("the warehouse records on their way to the host (plan СКЛ)", () => {
  it("sends the unsent records in their order, as kept, and keeps each receipt", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([recordStatement(PAIRING, record(1), AT), recordStatement(PAIRING, record(2), AT)]);
    const send = vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> => [
      { id: (records[0] as { id: string }).id, outcome: "accepted" },
      { id: (records[1] as { id: string }).id, outcome: "rejected", code: "subject_unknown" },
    ]);
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({ sent: 2, more: false });
    expect(send).toHaveBeenCalledWith([record(1), record(2)]);
    expect(rows(db, "SELECT attempts, outcome, outcome_code FROM wh_outbox ORDER BY seq")).toEqual([
      { attempts: 1, outcome: "accepted", outcome_code: null },
      { attempts: 1, outcome: "rejected", outcome_code: "subject_unknown" },
    ]);
    // Nothing more to send: the host is not asked.
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({ sent: 0, more: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing of receipts that do not answer the records, and sends the same batch again", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([recordStatement(PAIRING, record(1), AT)]);
    for (const answer of [[], [{ id: "another", outcome: "accepted" as const }], [{ id: null, outcome: "conflict" as const }]]) {
      await expect(
        sendWarehouseBatch(executor, PAIRING, async () => answer, () => new Date(AT)),
      ).rejects.toBeInstanceOf(ReceiptMismatchError);
    }
    expect(rows(db, "SELECT attempts, outcome FROM wh_outbox")).toEqual([{ attempts: 3, outcome: null }]);
  });
});
```

Run — FAIL (модуля нет).

- [ ] **Шаг 2: отправитель.** Создать `apps/standalone/src/local/warehouse-sender.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { FactReceipt } from "../host/protocol.js";
import type { LocalExecutor } from "./executor.js";
import { ReceiptMismatchError, type SendResult } from "./facts-sender.js";
import type { Pairing } from "./reference-sync.js";

/** The most records of one batch, as the host takes them. */
export const MAX_WAREHOUSE_BATCH = 100;

/** This pairing's oldest records without a receipt, in the order they were kept. */
export const WAREHOUSE_UNSENT_SQL =
  "SELECT id, payload FROM wh_outbox WHERE host_id = ? AND device_id = ? " +
  "AND acked_at IS NULL ORDER BY seq LIMIT ?";

/**
 * Counts a send of each record of a JSON list before it leaves. The pluses keep
 * the planner on the records' own key (as the facts' sender, `facts-sender.ts`).
 */
export const WAREHOUSE_ATTEMPT_SQL =
  "UPDATE wh_outbox SET attempts = attempts + 1, sent_at = ? WHERE +host_id = ? " +
  "AND +device_id = ? AND id IN (SELECT value FROM json_each(?))";

/** The receipts of a batch (a JSON list of `{ id, outcome, code? }`), on records still waiting. */
export const WAREHOUSE_RECEIPT_SQL =
  "UPDATE wh_outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> " +
  "'code', acked_at = ? FROM json_each(?) AS r WHERE wh_outbox.id = r.value ->> 'id' " +
  "AND +wh_outbox.host_id = ? AND +wh_outbox.device_id = ? AND +wh_outbox.acked_at " +
  "IS NULL";

const unsentRow = z.object({ id: z.string(), payload: z.string() });

/**
 * One batch of the warehouse records to the host (plan СКЛ, decision Р17): up to
 * 100 of this pairing's oldest records without a receipt, sent as kept, each send
 * counted first. The receipts must answer the records — as many, each with its
 * record's id or none, `accepted` or `rejected` — and are written in ONE
 * transaction; otherwise nothing is kept and the same batch goes again. A record
 * with a receipt never goes again; the retention removes it with its session.
 * Records are small (well under 1 KiB), so a batch needs no byte budget.
 */
export async function sendWarehouseBatch(
  local: LocalExecutor,
  pairing: Pairing,
  send: (records: readonly unknown[]) => Promise<FactReceipt[]>,
  now: () => Date,
): Promise<SendResult> {
  const waiting = await local.query(
    WAREHOUSE_UNSENT_SQL,
    [pairing.hostId, pairing.deviceId, MAX_WAREHOUSE_BATCH],
    unsentRow,
  );
  if (waiting.length === 0) return { sent: 0, more: false };
  await local.transaction([
    {
      sql: WAREHOUSE_ATTEMPT_SQL,
      values: [
        now().toISOString(),
        pairing.hostId,
        pairing.deviceId,
        JSON.stringify(waiting.map((row) => row.id)),
      ],
    },
  ]);
  const receipts = await send(waiting.map((row): unknown => JSON.parse(row.payload)));
  if (receipts.length !== waiting.length) {
    throw new ReceiptMismatchError(`${receipts.length} receipts for ${waiting.length} records`);
  }
  const answers = waiting.map((row, index) => {
    const receipt = receipts[index];
    if (
      receipt === undefined ||
      (receipt.id !== null && receipt.id !== row.id) ||
      receipt.outcome === "conflict"
    ) {
      throw new ReceiptMismatchError(`receipt ${index} does not answer its record`);
    }
    return {
      id: row.id,
      outcome: receipt.outcome,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
    };
  });
  await local.transaction([
    {
      sql: WAREHOUSE_RECEIPT_SQL,
      values: [now().toISOString(), JSON.stringify(answers), pairing.hostId, pairing.deviceId],
    },
  ]);
  return { sent: waiting.length, more: waiting.length === MAX_WAREHOUSE_BATCH };
}
```

Если `SendResult` не экспортирован из `facts-sender.ts` — он объявлен там как `export interface SendResult` (есть); `ReceiptMismatchError` — `export class` (есть).

- [ ] **Шаг 3: тексты отправителя в закреплённых планах.** В `apps/standalone/test/floor-schema.test.ts` добавить импорт `import { WAREHOUSE_ATTEMPT_SQL, WAREHOUSE_RECEIPT_SQL, WAREHOUSE_UNSENT_SQL } from "../src/local/warehouse-sender.js";` и в описание `the warehouse reprint's statements (migration 0012)` массив `STATEMENTS` дописать тремя строками:

<!-- prettier-ignore -->
```ts
    [WAREHOUSE_UNSENT_SQL, "wh_outbox_unsent"],
    [WAREHOUSE_ATTEMPT_SQL, "sqlite_autoindex_wh_outbox_1 (id=?)"],
    [WAREHOUSE_RECEIPT_SQL, "sqlite_autoindex_wh_outbox_1 (id=?)"],
```

(Rust-сторона уже держит эти тексты — задача 4.)

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-sender.test.ts test/floor-schema.test.ts` — PASS.

- [ ] **Шаг 4: связь.** В `apps/standalone/src/app/host-link.ts`:

Найти `import { sendFactBatch } from "../local/facts-sender.js";` и заменить на:

<!-- prettier-ignore -->
```ts
import { sendFactBatch } from "../local/facts-sender.js";
import { sendWarehouseBatch } from "../local/warehouse-sender.js";
```

Найти в `HostLinkOptions`:

<!-- prettier-ignore -->
```ts
  /** `HostApi.registerKnownBlocks`: this station's blocks back to a host restored from a copy. */
  registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
```

и заменить на:

<!-- prettier-ignore -->
```ts
  /** `HostApi.registerKnownBlocks`: this station's blocks back to a host restored from a copy. */
  registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  /**
   * `HostApi.sendWarehouseRecords` (plan СКЛ): the warehouse reprint's records go
   * after the facts, by the same delivery; none — they wait.
   */
  sendWarehouseRecords?: (records: readonly unknown[]) => Promise<FactReceipt[]>;
```

(Если `FactReceipt` в этом файле не импортирован как тип — он уже нужен для `sendFacts`; проверить импорт из `../host/protocol.js`.)

Найти в параметрах функции `  registerKnownBlocks,\n  dispatch,\n}: HostLinkOptions): HostLinkControls {` и заменить на `  registerKnownBlocks,\n  sendWarehouseRecords,\n  dispatch,\n}: HostLinkOptions): HostLinkControls {`.

Найти:

<!-- prettier-ignore -->
```ts
        const { sent, more } = await sendFactBatch(
          local,
          { hostId, deviceId },
          sendFacts,
          () => new Date(),
        );
        if (!active) return;
        factFailures = 0;
        dispatch({ type: "facts_sent" });
        if (sent > 0) dispatch({ type: "outbox_changed" });
        if (more) factSender.trigger();
```

и заменить на:

<!-- prettier-ignore -->
```ts
        const { sent, more } = await sendFactBatch(
          local,
          { hostId, deviceId },
          sendFacts,
          () => new Date(),
        );
        if (!active) return;
        // The warehouse records (plan СКЛ) once no fact waits. Their failure is
        // not the facts': a refused key or a changed certificate still ends the
        // link; anything else keeps them for the next delivery.
        let warehouse = { sent: 0, more: false };
        if (!more && sendWarehouseRecords !== undefined) {
          try {
            warehouse = await sendWarehouseBatch(
              local,
              { hostId, deviceId },
              sendWarehouseRecords,
              () => new Date(),
            );
          } catch (error) {
            if (shellActionFor(error, null) !== null) throw error;
          }
          if (!active) return;
        }
        factFailures = 0;
        dispatch({ type: "facts_sent" });
        if (sent > 0 || warehouse.sent > 0) dispatch({ type: "outbox_changed" });
        if (more || warehouse.more) factSender.trigger();
```

В массиве зависимостей эффекта найти `    registerKnownBlocks,\n    dispatch,\n  ]);` и заменить на `    registerKnownBlocks,\n    sendWarehouseRecords,\n    dispatch,\n  ]);`.

В `apps/standalone/src/app/App.tsx`:

Найти `import { purgeAcknowledged, scheduleRetention } from "../local/retention.js";` и заменить на:

<!-- prettier-ignore -->
```ts
import { purgeWarehouseSessions } from "../floor/warehouse/warehouse-store.js";
import { purgeAcknowledged, scheduleRetention } from "../local/retention.js";
```

Найти:

<!-- prettier-ignore -->
```ts
    return scheduleRetention(async () => {
      if ((await purgeAcknowledged(localDb, pairing, new Date())) > 0) {
        dispatch({ type: "outbox_changed" });
      }
    });
```

и заменить на:

<!-- prettier-ignore -->
```ts
    return scheduleRetention(async () => {
      const shifts = await purgeAcknowledged(localDb, pairing, new Date());
      // The warehouse sessions done with (plan СКЛ) go in the same hourly pass.
      const sessions = await purgeWarehouseSessions(localDb, pairing, new Date());
      if (shifts + sessions > 0) dispatch({ type: "outbox_changed" });
    });
```

Найти `    sendFacts: hostApi.sendFacts,\n    registerKnownBlocks: hostApi.registerKnownBlocks,` и заменить на `    sendFacts: hostApi.sendFacts,\n    registerKnownBlocks: hostApi.registerKnownBlocks,\n    sendWarehouseRecords: hostApi.sendWarehouseRecords,`.

- [ ] **Шаг 5: тест связи.** В `apps/standalone/test/warehouse-sender.test.ts` дописать тест доставки через `useHostLink` по образцу `test/host-link-facts.test.ts` (его помощники связи — `fakeConnection` и статус `online`, — взять оттуда; если они локальны в том файле, скопировать минимально): запись в `wh_outbox`, связь выходит на связь, `sendFacts` отвечает `[]` (фактов нет), `sendWarehouseRecords` вызывается с записью и отвечает `accepted` — `wh_outbox.outcome = 'accepted'`, `dispatch` получил `outbox_changed`; второй прогон, где `sendWarehouseRecords` бросает `HostError({ kind: "api", code: "not_found", status: 404 })` — `dispatch` получил `facts_sent`, не `facts_failed`, запись без квитанции. Исполнитель пишет тест по образцу и записывает его имя в отклонения.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-sender.test.ts test/host-link-facts.test.ts test/host-link-shifts.test.ts test/host-link-restore.test.ts test/app.test.tsx` — PASS.

- [ ] **Шаг 6: мутация.** В `host-link.ts` убрать `!more &&` — тест доставки не меняется; вместо этого мутация «не глотать ошибку записей» (`catch` → `throw error`) — FAIL второй прогон (`facts_failed`). Вернуть.

- [ ] **Шаг 7: коммит.** `git add apps/standalone/src/local/warehouse-sender.ts apps/standalone/test/warehouse-sender.test.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/test/floor-schema.test.ts`; сообщение `feat(standalone): deliver warehouse reprint records after the facts, hourly retention (plan СКЛ task 6)` + трейлер.

---

## Задача 7: экран «Повторная печать этикеток» и выбор шаблонов

**Files:**

- Create: `apps/standalone/src/floor/warehouse/WarehouseScreen.tsx`, `apps/standalone/src/floor/warehouse/TemplatePicker.tsx`, `apps/standalone/test/warehouse-screen.test.tsx`
- Modify: `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`

**Interfaces:** `WarehouseScreen(props: WarehouseScreenProps)`; `TemplatePicker({ templates, chosen, source, onApply, onCancel })`.

- [ ] **Шаг 1: тексты.** В `apps/standalone/src/i18n/ru.json` внутри `"floor"` после объекта `"signIn": { … }` (последний ключ `floor`; найти закрывающую скобку `signIn` и запятую по месту) добавить ключ `"warehouse"`:

<!-- prettier-ignore -->
```json
    "warehouse": {
      "open": "Повторная печать этикеток",
      "title": "Повторная печать этикеток",
      "loading": "Читаем сеанс перепечатки…",
      "readFailed": "Не удалось прочитать сеанс перепечатки на этом компьютере.",
      "retry": "Повторить",
      "scope": "Перепечатка не создаёт новых кодов, коробов и паллет и не меняет количество продукции.",
      "reason": "Причина перепечатки",
      "reasons": {
        "not_printed": "Не напечаталась",
        "damaged": "Повреждена",
        "lost": "Утеряна"
      },
      "start": "Начать перепечатку",
      "resumed": "Продолжен незавершённый сеанс перепечатки.",
      "sessionReason": "Причина: {{reason}}",
      "changeReason": "Изменить причину",
      "applyReason": "Применить причину",
      "templatesTitle": "Шаблоны этикеток",
      "templateFor": {
        "unit": "Коды единиц",
        "box": "Короба",
        "pallet": "Паллеты"
      },
      "templateLine": "{{kind}}: {{name}}",
      "templateNone": "не выбран",
      "chooseTemplates": "Шаблоны",
      "search": "Поиск шаблона",
      "noTemplates": "Нет включённых шаблонов этого назначения. Добавьте шаблон в офисе.",
      "noMatch": "По этому запросу шаблонов нет.",
      "size": "{{width}} × {{height}} мм",
      "previewSample": "Образец: данные примерные",
      "previewNone": "Выберите шаблон для предпросмотра.",
      "apply": "Применить шаблоны",
      "cancel": "Отмена",
      "sentCount": "Этикеток передано на принтер: {{sent}}",
      "waiting": "Записи ждут отправки на хост: {{waiting}}",
      "prompt": "Отсканируйте код единицы, короба или паллеты.",
      "manual": "Ввести код вручную",
      "manualLabel": "Номер короба или паллеты (18 цифр) либо полный код единицы",
      "manualSubmit": "Найти и напечатать",
      "pause": "К сменам",
      "finish": "Завершить сеанс",
      "finishTitle": "Завершить сеанс перепечатки?",
      "finishText": "Этикеток передано на принтер: {{sent}}. Завершённый сеанс больше не продолжается; записи уйдут на хост.",
      "finishConfirm": "Завершить",
      "finishBlocked": "Сначала решите незавершённую печать.",
      "subject": {
        "unit": "Код единицы",
        "box": "Короб {{sscc}}",
        "pallet": "Паллета {{sscc}}"
      },
      "status": {
        "looking": "Ищем код на хосте…",
        "prepared": "Этикетка готова к отправке",
        "sending": "Передаём этикетку на принтер…",
        "sent": "Этикетка передана на принтер",
        "verified": "Новая этикетка проверена",
        "unknown": "Неизвестно, вышла ли этикетка",
        "failed": "Этикетка не отправлена",
        "cancelled": "Печать отменена",
        "duplicate": "Этот код уже печатали в этом сеансе",
        "verify": "Отсканируйте новую этикетку"
      },
      "hint": {
        "sent": "Это не подтверждает выход этикетки. Можно сканировать следующий код.",
        "unknown": "Проверьте принтер. Если этикетка вышла — отсканируйте её. Иначе напечатайте ещё раз с причиной.",
        "duplicate": "Для ещё одной этикетки нажмите «Напечатать ещё раз» и выберите причину.",
        "verify": "Скан старой этикетки с «!1» новую печать не подтверждает."
      },
      "legacyRepair": "Распознана старая этикетка с «!1»: новая — с тем же SSCC без ошибки.",
      "printerUnconfigured": "Для этого типа этикетки не назначен принтер. Назначьте его в «Рабочее место».",
      "send": "Отправить",
      "printAgain": "Напечатать ещё раз",
      "againTitle": "Причина новой попытки",
      "againText": "Этикетка могла уже выйти. На принтер уйдут те же данные.",
      "againConfirm": "Напечатать",
      "retrySend": "Повторить отправку",
      "cancelJob": "Отменить печать",
      "verifyButton": "Проверить сканом",
      "verifyCancel": "Отменить проверку",
      "setup": "Рабочее место",
      "errors": {
        "invalid_scan": "Не удалось распознать код единицы или SSCC.",
        "offline": "Нет связи с хостом: найти код нельзя. Дождитесь связи и отсканируйте снова.",
        "host_outdated": "Хост не поддерживает повторную печать. Обновите хост.",
        "restore_pending": "Хост восстановлен из копии и ждёт решения офиса: поиск недоступен.",
        "lookup_failed": "Хост не ответил на поиск. Отсканируйте снова.",
        "not_found": "Код не найден в базе хоста. Проверьте этикетку.",
        "released": "Код снят с учёта исключением: перепечатка недоступна.",
        "disassembled": "Короб или паллета расформированы: перепечатка недоступна.",
        "incomplete_km": "В базе нет полного кода маркировки с криптохвостом: печать запрещена.",
        "no_template": "Не выбран шаблон для этого типа этикетки. Нажмите «Шаблоны».",
        "template_unavailable": "Выбранный шаблон отключён, удалён или не читается. Выберите другой.",
        "template_unfit": "Шаблон не подходит этому товару или типу этикетки. Выберите другой.",
        "operator_denied": "Доступ оператора отозван. Войдите под действующим оператором.",
        "busy": "Сначала решите текущую печать.",
        "verify_mismatch": "Код не совпадает с новой этикеткой. Отсканируйте именно новую этикетку.",
        "verify_invalid": "Это не код новой этикетки.",
        "write_failed": "Не удалось записать задание на этом компьютере. Ничего не напечатано."
      }
    }
```

Проверить уникальность ключей: `node -e 'JSON.parse(require("fs").readFileSync("apps/standalone/src/i18n/ru.json","utf8"))'` и тест `test/i18n*.test.ts` пакета, если есть (дубликаты ключей ловит он).

- [ ] **Шаг 2: стили.** В конец `apps/standalone/src/app/shell.css` дописать:

<!-- prettier-ignore -->
```css
/* The warehouse reprint (plan СКЛ): reason buttons in a row, the template list beside its preview. */
.warehouse {
  width: min(960px, 100%);
}

.warehouse__choices {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 0;
  border: 0;
}

.warehouse__templates {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.warehouse-picker__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 300px);
  gap: 16px;
  align-items: start;
}

.warehouse-picker__list {
  display: grid;
  gap: 8px;
  max-height: 360px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.warehouse-picker__preview {
  display: grid;
  gap: 8px;
  justify-items: center;
}

.warehouse-picker__preview canvas {
  border: 1px solid var(--line-strong);
  background: #ffffff;
}
```

- [ ] **Шаг 3: тест экрана (RED).** Создать `apps/standalone/test/warehouse-screen.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { WarehouseScreen, type WarehouseScreenProps } from "../src/floor/warehouse/WarehouseScreen.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import type { WarehouseLookup, WarehouseLookupResult } from "../src/host/protocol.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { manualRuntime, setUpPrinting } from "./support/printing.js";
import { BOX_SOURCE, BOX_SSCC, seedWarehouseCopies, warehouseRender } from "./support/warehouse.js";
import { fakeSource, SESSION } from "./support/work-screen.js";

async function renderScreen(options: { online?: boolean; lookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult> } = {}) {
  const { db, executor } = openLocalDb();
  seedWarehouseCopies(db);
  await setUpPrinting(executor, { assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" } });
  const gate = createWorkGate();
  const scanner = fakeSource();
  const shell = fakeHardware();
  const lookup = vi.fn(options.lookup ?? (async (): Promise<WarehouseLookupResult> => ({ status: "found", source: BOX_SOURCE })));
  let id = 0;
  const props: WarehouseScreenProps = {
    operator: SESSION,
    local: executor,
    pairing: PAIRING,
    online: options.online ?? true,
    track: gate.track,
    touch: vi.fn(),
    isLeaving: () => false,
    source: scanner.source,
    lookup,
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    printing: manualRuntime(shell.hardware).runtime,
    onLeave: vi.fn(),
    onSetup: vi.fn(),
    render: warehouseRender,
    now: () => new Date("2026-10-09T07:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
  };
  render(
    <ThemeProvider>
      <WarehouseScreen {...props} />
    </ThemeProvider>,
  );
  const settled = () => act(() => gate.drain());
  const scan = async (raw: string) => {
    await act(async () => {
      scanner.emit(raw);
      await gate.drain();
    });
  };
  const press = async (name: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
      await gate.drain();
    });
  };
  return { db, props, scanner, shell, lookup, settled, scan, press };
}

async function started(options: Parameters<typeof renderScreen>[0] = {}) {
  const at = await renderScreen(options);
  await screen.findByRole("button", { name: "Начать перепечатку" });
  await at.press("Повреждена");
  await at.press("Начать перепечатку");
  await at.scanner.listening();
  return at;
}

describe("the warehouse reprint screen (plan СКЛ)", () => {
  it("starts a session with a reason and the organization's templates, and prints a box found on the host", async () => {
    const at = await renderScreen();
    expect(await screen.findByText("Коды единиц: Дубль 58×40")).toBeTruthy();
    expect(screen.getByText("Короба: Коробка 58×40")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Начать перепечатку" }).hasAttribute("disabled")).toBe(true);
    await at.press("Повреждена");
    await at.press("Начать перепечатку");
    await at.scanner.listening();
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(screen.getByText("Этикеток передано на принтер: 1")).toBeTruthy();
    expect(at.lookup).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(at.shell.sends).toHaveLength(1);
    expect(at.props.onRecorded).toHaveBeenCalled();
    expect(rows(at.db, "SELECT reason, started_by FROM wh_sessions")).toEqual([{ reason: "damaged", started_by: OPERATOR_ID }]);
  });

  it("says honestly that nothing is found without the host, and prints nothing", async () => {
    const at = await started({ online: false });
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Нет связи с хостом: найти код нельзя. Дождитесь связи и отсканируйте снова.")).toBeTruthy();
    expect(at.lookup).not.toHaveBeenCalled();
    expect(at.shell.sends).toHaveLength(0);
  });

  it("prints a code of the session again only after a reason is chosen", async () => {
    const at = await started();
    await at.scan(BOX_SSCC);
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этот код уже печатали в этом сеансе/)).toBeTruthy();
    expect(at.shell.sends).toHaveLength(1);
    await at.press("Напечатать ещё раз");
    expect(screen.getByRole("heading", { name: "Причина новой попытки" })).toBeTruthy();
    await at.press("Утеряна");
    await at.press("Напечатать");
    expect(at.shell.sends).toHaveLength(2);
    expect(rows(at.db, "SELECT reason, attempts FROM wh_jobs")).toEqual([{ reason: "lost", attempts: 2 }]);
  });

  it("continues an open session after a pause, and finishes it after a confirmation", async () => {
    const at = await started();
    await at.scan(BOX_SSCC);
    await at.press("К сменам");
    expect(at.props.onLeave).toHaveBeenCalledTimes(1);
    await at.press("Завершить сеанс");
    expect(screen.getByRole("heading", { name: "Завершить сеанс перепечатки?" })).toBeTruthy();
    await at.press("Завершить");
    expect(at.props.onLeave).toHaveBeenCalledTimes(2);
    expect(rows(at.db, "SELECT finished_by FROM wh_sessions")).toEqual([{ finished_by: OPERATOR_ID }]);
  });

  it("chooses templates from a searchable list, kept for each kind of label", async () => {
    const at = await renderScreen();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Шаблоны");
    expect(screen.getByRole("heading", { name: "Шаблоны этикеток" })).toBeTruthy();
    await at.press("Короба");
    const search = screen.getByLabelText("Поиск шаблона");
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "нет такого" } });
    expect(screen.getByText("По этому запросу шаблонов нет.")).toBeTruthy();
    expect(at.scanner.textEntry).toContain(true);
    fireEvent.change(search, { target: { value: "короб" } });
    expect(screen.getByRole("button", { name: /Коробка 58×40/ }).getAttribute("aria-pressed")).toBe("true");
    await at.press("Применить шаблоны");
    expect(await screen.findByText("Короба: Коробка 58×40")).toBeTruthy();
    expect(at.scanner.textEntry.at(-1)).toBe(false);
  });

  it("looks a typed SSCC up as a scan, and takes no scan while the form is open", async () => {
    const at = await started();
    await at.press("Ввести код вручную");
    await at.scan(BOX_SSCC);
    expect(at.lookup).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Номер короба или паллеты (18 цифр) либо полный код единицы"), { target: { value: BOX_SSCC } });
    await at.press("Найти и напечатать");
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(at.lookup).toHaveBeenCalledTimes(1);
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-screen.test.tsx` — FAIL (модуля нет).

- [ ] **Шаг 4: выбор шаблонов.** Создать `apps/standalone/src/floor/warehouse/TemplatePicker.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@markiro/ui";

import { WAREHOUSE_SUBJECT_KINDS, type WarehouseSubjectKind } from "../../host/protocol.js";
import { drawLabel, paintCodeRasters } from "../../office/templates/label-renderer.js";
import { useLabelRendering } from "../../office/templates/label-rendering.js";
import { labelRenderOptions, labelSampleData } from "../../office/templates/label-samples.js";
import type { ScanSource } from "../scan-source.js";
import type { WarehouseTemplates } from "./warehouse-store.js";
import { isChoosable, KIND_PURPOSE, type WarehouseTemplate } from "./warehouse-templates.js";

/** The preview's box; the label keeps its own proportions inside it. */
const PREVIEW_PX = 280;

/** A template drawn with its purpose's sample data, as the office's thumbnail; nothing in a webview without a canvas. */
function TemplatePreview({ template }: { template: WarehouseTemplate | null }) {
  const { t } = useTranslation();
  const { context } = useLabelRendering();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spec = template?.spec ?? null;
  const scale = spec === null ? 0 : Math.min(PREVIEW_PX / spec.widthMm, PREVIEW_PX / spec.heightMm);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || spec === null || template === null) return undefined;
    const drawing = context(canvas);
    if (drawing === null) return undefined;
    const data = labelSampleData(template.purpose);
    const options = labelRenderOptions(template.purpose);
    drawLabel(spec, drawing, scale, data, options);
    let cancelled = false;
    void paintCodeRasters(spec, drawing, scale, data, options, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [context, spec, scale, template]);
  if (template === null || spec === null) {
    return <p className="warehouse-picker__preview">{t("floor.warehouse.previewNone")}</p>;
  }
  return (
    <figure className="warehouse-picker__preview">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        width={Math.round(spec.widthMm * scale)}
        height={Math.round(spec.heightMm * scale)}
      />
      <figcaption>
        {template.name} · {t("floor.warehouse.size", { width: spec.widthMm, height: spec.heightMm })}
        <br />
        {t("floor.warehouse.previewSample")}
      </figcaption>
    </figure>
  );
}

export interface TemplatePickerProps {
  templates: readonly WarehouseTemplate[];
  chosen: WarehouseTemplates;
  source: ScanSource;
  onApply: (templates: WarehouseTemplates) => void;
  onCancel: () => void;
}

/**
 * The templates of a reprint session (the cloud's `TemplateChoiceList`): one kind of
 * label at a time, its enabled templates found by name, the chosen one previewed with
 * sample data (said so). A choice of one kind is kept while another is chosen;
 * «Отмена» keeps the session's templates. While the search takes typing the scanner
 * is quiet (`setManualTextEntryActive`).
 */
export function TemplatePicker({ templates, chosen, source, onApply, onCancel }: TemplatePickerProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<WarehouseSubjectKind>("unit");
  const [draft, setDraft] = useState<WarehouseTemplates>(chosen);
  const [query, setQuery] = useState("");
  useEffect(() => () => source.setManualTextEntryActive(false), [source]);
  const choosable = useMemo(
    () => templates.filter((template) => isChoosable(template, kind)),
    [templates, kind],
  );
  const needle = query.trim().toLocaleLowerCase("ru");
  const listed = choosable.filter((template) =>
    template.name.toLocaleLowerCase("ru").includes(needle),
  );
  const selected = templates.find((template) => template.id === draft[kind]) ?? null;
  return (
    <section className="standalone-form warehouse-picker" aria-labelledby="warehouse-picker-title">
      <h3 id="warehouse-picker-title">{t("floor.warehouse.templatesTitle")}</h3>
      <div className="warehouse__choices" role="group" aria-label={t("floor.warehouse.templatesTitle")}>
        {WAREHOUSE_SUBJECT_KINDS.map((each) => (
          <Button
            key={each}
            size="floor"
            variant={each === kind ? "primary" : "secondary"}
            aria-pressed={each === kind}
            onClick={() => {
              setKind(each);
              setQuery("");
            }}
          >
            {t(`floor.warehouse.templateFor.${each}`)}
          </Button>
        ))}
      </div>
      <Input
        size="floor"
        label={t("floor.warehouse.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => source.setManualTextEntryActive(true)}
        onBlur={() => source.setManualTextEntryActive(false)}
      />
      <div className="warehouse-picker__body">
        <div>
          {choosable.length === 0 ? (
            <p>{t("floor.warehouse.noTemplates")}</p>
          ) : listed.length === 0 ? (
            <p>{t("floor.warehouse.noMatch")}</p>
          ) : (
            <ul className="warehouse-picker__list">
              {listed.map((template) => (
                <li key={template.id}>
                  <Button
                    size="floor"
                    variant={template.id === draft[kind] ? "primary" : "secondary"}
                    aria-pressed={template.id === draft[kind]}
                    onClick={() => setDraft({ ...draft, [kind]: template.id })}
                  >
                    {template.spec === null
                      ? template.name
                      : `${template.name} · ${t("floor.warehouse.size", {
                          width: template.spec.widthMm,
                          height: template.spec.heightMm,
                        })}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <TemplatePreview template={selected !== null && selected.purpose === KIND_PURPOSE[kind] ? selected : null} />
      </div>
      <div className="standalone-form__actions">
        <Button size="floor" onClick={() => onApply(draft)}>
          {t("floor.warehouse.apply")}
        </Button>
        <Button size="floor" variant="secondary" onClick={onCancel}>
          {t("floor.warehouse.cancel")}
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Шаг 5: экран.** Создать `apps/standalone/src/floor/warehouse/WarehouseScreen.tsx`:

<!-- prettier-ignore -->
```tsx
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input, type AlertTone } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import {
  WAREHOUSE_REASONS,
  WAREHOUSE_SUBJECT_KINDS,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { createWorkQueue } from "../work/work-queue.js";
import { TemplatePicker } from "./TemplatePicker.js";
import {
  countSent,
  countUnsentRecords,
  finishSession,
  readOpenSession,
  startSession,
  updateSession,
  type WarehouseJob,
  type WarehouseReason,
  type WarehouseRepair,
  type WarehouseSession,
  type WarehouseTemplates,
} from "./warehouse-store.js";
import {
  initialTemplates,
  readOrgDefaults,
  readWarehouseTemplates,
  type WarehouseTemplate,
} from "./warehouse-templates.js";
import {
  cancelWarehouseJob,
  recoverWarehouseJob,
  reprintScan,
  sendWarehouseJob,
  verifyWarehouseJob,
  WarehousePrinterError,
  type RenderWarehouseLabel,
  type ScanOutcome,
  type SendIntent,
  type WarehouseContext,
} from "./warehouse-work.js";

export interface WarehouseScreenProps {
  operator: FloorSession;
  local: LocalExecutor;
  pairing: Pairing;
  /** The link to the host is online: only then is a code looked up. */
  online: boolean;
  /** `WorkGate.track`: every write and send of the screen, so a leave waits for it (N9). */
  track: <T>(work: Promise<T>) => Promise<T>;
  /** Starts the operator's idle wait again. */
  touch: () => void;
  /** True from the moment a leave is asked for: no scan is taken after it. */
  isLeaving: () => boolean;
  source: ScanSource;
  /** `HostApi.warehouseLookup`. */
  lookup: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  /** A record was written: the delivery goes. */
  onRecorded: () => void;
  printing: PrintRuntime;
  /** «К сменам» and a finished session. */
  onLeave: () => void;
  /** «Рабочее место»; back to this session. */
  onSetup: () => void;
  render?: RenderWarehouseLabel;
  now?: () => Date;
  newId?: () => string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "read_failed" }
  | { kind: "setup"; reason: WarehouseReason | null; templates: WarehouseTemplates }
  | { kind: "working"; session: WarehouseSession };

type Panel =
  | { kind: "none" }
  | { kind: "templates" }
  | { kind: "reason"; picked: WarehouseReason }
  | { kind: "again"; job: WarehouseJob; picked: WarehouseReason | null }
  | { kind: "manual" }
  | { kind: "finish" };

/** What the screen says of the last thing it did; the tone is said by the words too. */
interface Said {
  tone: AlertTone;
  text: string;
}

const defaultNow = () => new Date();
const defaultNewId = () => crypto.randomUUID();

/**
 * «Повторная печать этикеток» (plan СКЛ, pilot spec §30): the cloud station's warehouse
 * reprint for one site. A session (its reason and templates) is started, paused by
 * «К сменам» and continued by the next entry, and finished with a confirmation. A scan
 * or a typed code is looked up on the host and printed once on the printer of its kind;
 * a code of the session is printed again only on «Напечатать ещё раз» with a reason; a
 * failed job is retried or cancelled, an unknown one checked by a scan of the new label
 * or printed again with a reason — never sent again by itself. All work runs one thing
 * at a time (`createWorkQueue`) and is handed to `track`.
 */
export function WarehouseScreen({
  operator,
  local,
  pairing,
  online,
  track,
  touch,
  isLeaving,
  source,
  lookup,
  onHostError,
  onRecorded,
  printing,
  onLeave,
  onSetup,
  render,
  now = defaultNow,
  newId = defaultNewId,
}: WarehouseScreenProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const context = useMemo<WarehouseContext>(
    () => ({
      local,
      pairing: { hostId, deviceId },
      runtime: printing,
      now,
      newId,
      ...(render === undefined ? {} : { render }),
    }),
    [local, hostId, deviceId, printing, now, newId, render],
  );
  const [queue] = useState(createWorkQueue);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [templates, setTemplates] = useState<WarehouseTemplate[]>([]);
  const [job, setJob] = useState<WarehouseJob | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [verifying, setVerifying] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [counts, setCounts] = useState({ sent: 0, waiting: 0 });
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(0);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // What the queued work reads when its turn comes.
  const latest = useRef({ phase, panel, verifying, online, job });
  useLayoutEffect(() => {
    latest.current = { phase, panel, verifying, online, job };
  });

  const recount = useCallback(
    async (sessionId: string | null) => {
      const pairingNow = { hostId, deviceId };
      const sent = sessionId === null ? 0 : await countSent(local, pairingNow, sessionId);
      const waiting = await countUnsentRecords(local, pairingNow);
      if (alive.current) setCounts({ sent, waiting });
    },
    [local, hostId, deviceId],
  );

  // The session as stored: none — a new one is set up; an open one is continued, its
  // waiting job recovered (a send cut by a restart becomes unknown).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [found, copies, defaults] = await Promise.all([
        readOpenSession(local, { hostId, deviceId }),
        readWarehouseTemplates(local),
        readOrgDefaults(local),
      ]);
      if (found === null) {
        return {
          phase: { kind: "setup", reason: null, templates: initialTemplates(copies, defaults) } satisfies Phase,
          copies,
          job: null,
        };
      }
      const open = await recoverWarehouseJob(context, found.id, operator.id);
      return { phase: { kind: "working", session: found } satisfies Phase, copies, job: open };
    };
    void track(queue.run(load)).then(
      (loaded) => {
        if (cancelled || !alive.current) return;
        setTemplates(loaded.copies);
        setJob(loaded.job);
        setPhase(loaded.phase);
        if (loaded.phase.kind === "working") {
          setSaid({ tone: "info", text: t("floor.warehouse.resumed") });
          void recount(loaded.phase.session.id);
          onRecorded();
        }
      },
      () => {
        if (!cancelled && alive.current) setPhase({ kind: "read_failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, local, hostId, deviceId, context, operator.id, queue, track, recount, onRecorded, t]);

  const codeText = (code: string | null): string =>
    code === null
      ? ""
      : code === "printer_unconfigured"
        ? t("floor.warehouse.printerUnconfigured")
        : t(`floor.print.codes.${code}`, { defaultValue: code });

  const jobSaid = (shown: WarehouseJob, repair: WarehouseRepair | null = null): Said => {
    const note = repair === null ? "" : ` ${t("floor.warehouse.legacyRepair")}`;
    switch (shown.state) {
      case "sent":
        return { tone: "ok", text: `${t("floor.warehouse.status.sent")}. ${t("floor.warehouse.hint.sent")}${note}` };
      case "verified":
        return { tone: "ok", text: t("floor.warehouse.status.verified") };
      case "unknown":
        return { tone: "warn", text: `${t("floor.warehouse.status.unknown")}. ${codeText(shown.errorCode)} ${t("floor.warehouse.hint.unknown")}` };
      case "failed":
        return { tone: "error", text: `${t("floor.warehouse.status.failed")}. ${codeText(shown.errorCode)}` };
      case "cancelled":
        return { tone: "info", text: t("floor.warehouse.status.cancelled") };
      case "prepared":
        return { tone: "info", text: t("floor.warehouse.status.prepared") };
      case "sending":
        return { tone: "info", text: t("floor.warehouse.status.sending") };
    }
  };

  const show = (outcome: ScanOutcome): void => {
    switch (outcome.kind) {
      case "printed":
        setJob(outcome.job);
        setVerifying(false);
        setSaid(jobSaid(outcome.job, outcome.repair));
        return;
      case "busy":
        setJob(outcome.job);
        setSaid({ tone: "warn", text: t("floor.warehouse.errors.busy") });
        return;
      case "duplicate":
        setJob(outcome.job);
        setSaid({ tone: "warn", text: `${t("floor.warehouse.status.duplicate")}. ${t("floor.warehouse.hint.duplicate")}` });
        return;
      case "host_error":
        onHostError(outcome.error);
        setSaid({ tone: "error", text: t("floor.warehouse.errors.lookup_failed") });
        return;
      case "unavailable":
        setSaid({ tone: "warn", text: t(`floor.warehouse.errors.${outcome.reason}`) });
        return;
      case "refused":
        setSaid({ tone: "error", text: t(`floor.warehouse.errors.${outcome.reason}`) });
        return;
      default:
        setSaid({
          tone: outcome.kind === "not_found" ? "warn" : "error",
          text: t(`floor.warehouse.errors.${outcome.kind}`),
        });
    }
  };

  /** Runs `work` in its turn, tracked; a failure of this computer is said, never thrown. */
  const run = (work: () => Promise<void>): void => {
    touch();
    if (isLeaving()) return;
    setBusy((count) => count + 1);
    void track(
      queue.run(async () => {
        try {
          await work();
        } catch (error) {
          if (!alive.current) return;
          if (error instanceof WarehousePrinterError) {
            setSaid({ tone: "error", text: codeText(error.code) });
          } else {
            setSaid({ tone: "error", text: t("floor.warehouse.errors.write_failed") });
          }
        } finally {
          if (alive.current) setBusy((count) => count - 1);
        }
      }),
    );
  };

  const reprint = async (session: WarehouseSession, raw: string): Promise<void> => {
    if (latest.current.online) setSaid({ tone: "info", text: t("floor.warehouse.status.looking") });
    const outcome = await reprintScan(context, {
      session,
      raw,
      operatorId: operator.id,
      online: latest.current.online,
      ask: lookup,
    });
    if (!alive.current) return;
    show(outcome);
    await recount(session.id);
    onRecorded();
  };

  const verify = async (current: WarehouseJob, raw: string): Promise<void> => {
    const answer = await verifyWarehouseJob(context, current, raw, operator.id);
    if (!alive.current) return;
    if (answer.kind === "verified") {
      setVerifying(false);
      setJob(answer.job);
      setSaid(jobSaid(answer.job));
      await recount(current.sessionId);
      onRecorded();
      return;
    }
    setSaid({
      tone: "error",
      text: t(answer.kind === "mismatch" ? "floor.warehouse.errors.verify_mismatch" : "floor.warehouse.errors.verify_invalid"),
    });
  };

  // The scanner, for the life of the screen; each scan in its turn.
  const onScan = useRef<(raw: string) => void>(() => undefined);
  useLayoutEffect(() => {
    onScan.current = (raw) =>
      run(async () => {
        const state = latest.current;
        // A form or a panel takes no scan; the setup takes none either.
        if (state.phase.kind !== "working" || state.panel.kind !== "none") return;
        if (state.verifying && state.job !== null) {
          await verify(state.job, raw);
          return;
        }
        await reprint(state.phase.session, raw);
      });
  });
  useEffect(() => source.start((raw) => onScan.current(raw)), [source]);
  // The typed code's field is the keyboard's while it is open.
  useEffect(() => {
    if (panel.kind !== "manual") return undefined;
    source.setManualTextEntryActive(true);
    return () => source.setManualTextEntryActive(false);
  }, [panel.kind, source]);

  const send = (current: WarehouseJob, intent: SendIntent) =>
    run(async () => {
      setSaid({ tone: "info", text: t("floor.warehouse.status.sending") });
      const after = await sendWarehouseJob(context, current, intent, operator.id);
      if (!alive.current) return;
      setJob(after);
      setSaid(jobSaid(after));
      await recount(after.sessionId);
      onRecorded();
    });

  const templateLines = (chosen: WarehouseTemplates) => (
    <ul className="warehouse__templates">
      {WAREHOUSE_SUBJECT_KINDS.map((kind) => (
        <li key={kind}>
          {t("floor.warehouse.templateLine", {
            kind: t(`floor.warehouse.templateFor.${kind}`),
            name: templates.find((template) => template.id === chosen[kind])?.name ?? t("floor.warehouse.templateNone"),
          })}
        </li>
      ))}
    </ul>
  );

  const reasonChoices = (picked: WarehouseReason | null, pick: (reason: WarehouseReason) => void) => (
    <fieldset className="warehouse__choices">
      <legend>{t("floor.warehouse.reason")}</legend>
      {WAREHOUSE_REASONS.map((reason) => (
        <Button
          key={reason}
          size="floor"
          variant={picked === reason ? "primary" : "secondary"}
          aria-pressed={picked === reason}
          onClick={() => pick(reason)}
        >
          {t(`floor.warehouse.reasons.${reason}`)}
        </Button>
      ))}
    </fieldset>
  );

  const card = (children: ReactNode) => (
    <Card className="standalone-card warehouse" title={t("floor.warehouse.title")} titleAs="h2">
      <div className="standalone-form">{children}</div>
    </Card>
  );

  if (phase.kind === "loading") return card(<p>{t("floor.warehouse.loading")}</p>);
  if (phase.kind === "read_failed") {
    return card(
      <>
        <Alert
          tone="error"
          action={
            <Button size="floor" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              {t("floor.warehouse.retry")}
            </Button>
          }
        >
          {t("floor.warehouse.readFailed")}
        </Alert>
        <div className="standalone-form__actions">
          <Button size="floor" variant="secondary" onClick={onLeave}>
            {t("floor.warehouse.pause")}
          </Button>
        </div>
      </>,
    );
  }

  const applyTemplates = (next: WarehouseTemplates) => {
    setPanel({ kind: "none" });
    if (phase.kind === "setup") {
      setPhase({ ...phase, templates: next });
      return;
    }
    const session = { ...phase.session, templates: next };
    run(async () => {
      await updateSession(local, { hostId, deviceId }, session, now().toISOString());
      if (alive.current) setPhase({ kind: "working", session });
    });
  };

  if (panel.kind === "templates") {
    return card(
      <TemplatePicker
        templates={templates}
        chosen={phase.kind === "setup" ? phase.templates : phase.session.templates}
        source={source}
        onApply={applyTemplates}
        onCancel={() => setPanel({ kind: "none" })}
      />,
    );
  }

  if (phase.kind === "setup") {
    const { reason } = phase;
    return card(
      <>
        <p>{t("floor.warehouse.scope")}</p>
        {reasonChoices(reason, (picked) => setPhase({ ...phase, reason: picked }))}
        <h3>{t("floor.warehouse.templatesTitle")}</h3>
        {templateLines(phase.templates)}
        <div className="standalone-form__actions">
          <Button
            size="floor"
            disabled={reason === null || busy > 0}
            onClick={() => {
              if (reason === null) return;
              run(async () => {
                const session = await startSession(local, { hostId, deviceId }, {
                  id: newId(),
                  reason,
                  templates: phase.templates,
                  operatorId: operator.id,
                  at: now().toISOString(),
                });
                if (!alive.current) return;
                setPhase({ kind: "working", session });
                setSaid(null);
                await recount(session.id);
              });
            }}
          >
            {t("floor.warehouse.start")}
          </Button>
          <Button size="floor" variant="secondary" onClick={() => setPanel({ kind: "templates" })}>
            {t("floor.warehouse.chooseTemplates")}
          </Button>
          <Button size="floor" variant="secondary" onClick={onLeave}>
            {t("floor.warehouse.pause")}
          </Button>
        </div>
      </>,
    );
  }

  const { session } = phase;

  if (panel.kind === "reason" || panel.kind === "again") {
    const again = panel.kind === "again";
    return card(
      <section aria-labelledby="warehouse-reason-title" className="standalone-form">
        <h3 id="warehouse-reason-title">
          {t(again ? "floor.warehouse.againTitle" : "floor.warehouse.changeReason")}
        </h3>
        {again && <p>{t("floor.warehouse.againText")}</p>}
        {reasonChoices(panel.picked, (picked) => setPanel({ ...panel, picked }))}
        <div className="standalone-form__actions">
          <Button
            size="floor"
            disabled={panel.picked === null || busy > 0}
            onClick={() => {
              const { picked } = panel;
              if (picked === null) return;
              setPanel({ kind: "none" });
              if (panel.kind === "again") {
                send(panel.job, { kind: "again", reason: picked });
                return;
              }
              const changed = { ...session, reason: picked };
              run(async () => {
                await updateSession(local, { hostId, deviceId }, changed, now().toISOString());
                if (alive.current) setPhase({ kind: "working", session: changed });
              });
            }}
          >
            {t(again ? "floor.warehouse.againConfirm" : "floor.warehouse.applyReason")}
          </Button>
          <Button size="floor" variant="secondary" onClick={() => setPanel({ kind: "none" })}>
            {t("floor.warehouse.cancel")}
          </Button>
        </div>
      </section>,
    );
  }

  if (panel.kind === "finish") {
    return card(
      <section aria-labelledby="warehouse-finish-title" className="standalone-form">
        <h3 id="warehouse-finish-title">{t("floor.warehouse.finishTitle")}</h3>
        <p>{t("floor.warehouse.finishText", { sent: counts.sent })}</p>
        <div className="standalone-form__actions">
          <Button
            size="floor"
            disabled={busy > 0}
            onClick={() =>
              run(async () => {
                const done = await finishSession(local, { hostId, deviceId }, session.id, operator.id, now().toISOString());
                if (!alive.current) return;
                setPanel({ kind: "none" });
                if (done === "finished") {
                  onRecorded();
                  onLeave();
                } else {
                  setSaid({ tone: "warn", text: t("floor.warehouse.finishBlocked") });
                }
              })
            }
          >
            {t("floor.warehouse.finishConfirm")}
          </Button>
          <Button size="floor" variant="secondary" onClick={() => setPanel({ kind: "none" })}>
            {t("floor.warehouse.cancel")}
          </Button>
        </div>
      </section>,
    );
  }

  const jobActions = (current: WarehouseJob) => {
    switch (current.state) {
      case "prepared":
        return (
          <Button size="floor" disabled={busy > 0} onClick={() => send(current, { kind: "first" })}>
            {t("floor.warehouse.send")}
          </Button>
        );
      case "failed":
        return (
          <>
            <Button size="floor" disabled={busy > 0} onClick={() => send(current, { kind: "retry" })}>
              {t("floor.warehouse.retrySend")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy > 0}
              onClick={() =>
                run(async () => {
                  const after = await cancelWarehouseJob(context, current, operator.id);
                  if (!alive.current) return;
                  setJob(after);
                  setSaid(jobSaid(after));
                  await recount(after.sessionId);
                  onRecorded();
                })
              }
            >
              {t("floor.warehouse.cancelJob")}
            </Button>
            {current.errorCode === "printer_unconfigured" && (
              <Button size="floor" variant="secondary" onClick={onSetup}>
                {t("floor.warehouse.setup")}
              </Button>
            )}
          </>
        );
      case "unknown":
        return (
          <>
            <Button size="floor" variant="secondary" aria-pressed={verifying} onClick={() => setVerifying((value) => !value)}>
              {t(verifying ? "floor.warehouse.verifyCancel" : "floor.warehouse.verifyButton")}
            </Button>
            <Button size="floor" disabled={busy > 0} onClick={() => setPanel({ kind: "again", job: current, picked: null })}>
              {t("floor.warehouse.printAgain")}
            </Button>
          </>
        );
      case "sent":
      case "verified":
        return (
          <Button size="floor" variant="secondary" disabled={busy > 0} onClick={() => setPanel({ kind: "again", job: current, picked: null })}>
            {t("floor.warehouse.printAgain")}
          </Button>
        );
      default:
        return null;
    }
  };

  const subject =
    job === null
      ? null
      : job.kind === "unit"
        ? t("floor.warehouse.subject.unit")
        : t(`floor.warehouse.subject.${job.kind}`, { sscc: job.identity });

  return card(
    <>
      <p>{t("floor.warehouse.sessionReason", { reason: t(`floor.warehouse.reasons.${session.reason}`) })}</p>
      {templateLines(session.templates)}
      <div className="floor-sign-in__message floor-sign-in__message--stack" aria-live="polite">
        {said !== null && (
          <Alert tone={said.tone} role="presentation">
            {said.text}
          </Alert>
        )}
        {verifying && <p>{`${t("floor.warehouse.status.verify")}. ${t("floor.warehouse.hint.verify")}`}</p>}
      </div>
      {job !== null && (
        <section className="standalone-form" {...(subject === null ? {} : { "aria-label": subject })}>
          <p>{subject}</p>
          <div className="standalone-form__actions">{jobActions(job)}</div>
        </section>
      )}
      {panel.kind === "manual" ? (
        <form
          className="standalone-form"
          onSubmit={(event) => {
            event.preventDefault();
            const typed = manual;
            setManual("");
            setPanel({ kind: "none" });
            run(() => reprint(session, typed));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPanel({ kind: "none" });
          }}
        >
          <Input
            size="floor"
            label={t("floor.warehouse.manualLabel")}
            value={manual}
            autoFocus
            onChange={(event) => setManual(event.target.value)}
          />
          <div className="standalone-form__actions">
            <Button size="floor" type="submit" disabled={manual.trim() === ""}>
              {t("floor.warehouse.manualSubmit")}
            </Button>
            <Button size="floor" variant="secondary" type="button" onClick={() => setPanel({ kind: "none" })}>
              {t("floor.warehouse.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="work-screen__waiting">{t("floor.warehouse.prompt")}</p>
      )}
      <p>{t("floor.warehouse.sentCount", { sent: counts.sent })}</p>
      {counts.waiting > 0 && <p>{t("floor.warehouse.waiting", { waiting: counts.waiting })}</p>}
      <div className="standalone-form__actions">
        <Button size="floor" variant="secondary" disabled={busy > 0} onClick={() => setPanel({ kind: "manual" })}>
          {t("floor.warehouse.manual")}
        </Button>
        <Button
          size="floor"
          variant="secondary"
          disabled={busy > 0 || (job !== null && ["prepared", "sending", "failed", "unknown"].includes(job.state))}
          onClick={() => setPanel({ kind: "templates" })}
        >
          {t("floor.warehouse.chooseTemplates")}
        </Button>
        <Button size="floor" variant="secondary" onClick={() => setPanel({ kind: "reason", picked: session.reason })}>
          {t("floor.warehouse.changeReason")}
        </Button>
        <Button size="floor" variant="secondary" onClick={() => setPanel({ kind: "finish" })}>
          {t("floor.warehouse.finish")}
        </Button>
        {/* Never held by work: the floor's leave waits for it (N9). */}
        <Button size="floor" variant="secondary" onClick={onLeave}>
          {t("floor.warehouse.pause")}
        </Button>
      </div>
    </>,
  );
}
```

Замечания для исполнителя (по смыслу, записать отклонения): правило `react-hooks/exhaustive-deps` может потребовать обернуть `run`/`reprint`/`verify` в `useCallback` или перенести их в `useRef`-обработчик — поведение не менять; тоны `Alert` — `ok`, `info`, `warn`, `error` (`AlertTone`); если `useCallback` окажется неиспользованным после правок — убрать импорт.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/warehouse-screen.test.tsx` — PASS без `stderr |`; затем под стендом с задержкой `setImmediate` (раздел «Заметки для исполнения») — PASS; временные файлы удалить.

- [ ] **Шаг 6: мутации.** (а) В обработчике скана убрать проверку `state.panel.kind !== "none"` — FAIL «looks a typed SSCC up as a scan, and takes no scan while the form is open». (б) Убрать `disabled={reason === null …}` у «Начать перепечатку» — FAIL первого теста. Вернуть.

- [ ] **Шаг 7: коммит.** `git add apps/standalone/src/floor/warehouse/WarehouseScreen.tsx apps/standalone/src/floor/warehouse/TemplatePicker.tsx apps/standalone/test/warehouse-screen.test.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css`; сообщение `feat(standalone): warehouse reprint screen with reasons, searchable templates and recovery (plan СКЛ task 7)` + трейлер.

---

## Задача 8: вход с экрана смен, проводка `FloorApp`, документы, итоговые проверки

**Files:**

- Modify: `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/test/floor-app.test.tsx`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

**Interfaces:** `ShiftListProps.onWarehouse?: () => void`; `FloorAppProps.warehouseLookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>`; вид `FloorView` `{ kind: "warehouse"; leaving: boolean }`; `Leave` `{ kind: "warehouse_setup" }`; `setup.back: WorkShift | "warehouse" | null`.

- [ ] **Шаг 1: тест (RED).** В `apps/standalone/test/floor-app.test.tsx`:

- в `interface Options` добавить `warehouseLookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;` (и импорт типов из `../src/host/protocol.js`);
- в `floorOf` перед `dispatch={handlers.dispatch}` добавить `{...(options.warehouseLookup === undefined ? {} : { warehouseLookup: options.warehouseLookup })}`;
- найти `describe("the workstation setup on the floor", () => {` и вставить перед ним:

<!-- prettier-ignore -->
```tsx
describe("the warehouse reprint on the floor (plan СКЛ)", () => {
  it("opens from the list of shifts only when the host can be asked, and comes back to it", async () => {
    const handlers = handlersOf();
    const { unmount } = render(floorOf(await floorCopies(), handlers));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторная печать этикеток" })).toBeNull();
    unmount();
    const lookup = vi.fn(async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }));
    render(floorOf(await floorCopies(), handlers, { warehouseLookup: lookup }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторная печать этикеток" }));
    expect(await screen.findByRole("heading", { name: "Повторная печать этикеток" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "К сменам" }));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(types(handlers)).not.toContain("work_entered");
    expect(types(handlers)).not.toContain("work_left");
  });
});

```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx` — FAIL новый тест.

- [ ] **Шаг 2: список смен.** В `apps/standalone/src/floor/shifts/ShiftList.tsx`:

Найти:

<!-- prettier-ignore -->
```tsx
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
}
```

и заменить на:

<!-- prettier-ignore -->
```tsx
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
  /** The warehouse reprint (plan СКЛ); none — no button. */
  onWarehouse?: () => void;
}
```

Найти в деструктуризации пропсов функции `ShiftList` параметр `onSetup,` (одна строка в списке параметров) и заменить на `onSetup,\n  onWarehouse,` (если пропсы читаются как `props.onSetup` — по смыслу).

Найти:

<!-- prettier-ignore -->
```tsx
          {onSetup !== undefined && (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
              {t("floor.shifts.setup")}
            </Button>
          )}
```

и заменить на:

<!-- prettier-ignore -->
```tsx
          {onSetup !== undefined && (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
              {t("floor.shifts.setup")}
            </Button>
          )}
          {onWarehouse !== undefined && (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onWarehouse}>
              {t("floor.warehouse.open")}
            </Button>
          )}
```

- [ ] **Шаг 3: `FloorApp`.** В `apps/standalone/src/floor/FloorApp.tsx`:

(1) Импорты: найти `import type {\n  CodeCheck,` и заменить на `import type {\n  WarehouseLookup,\n  WarehouseLookupResult,\n  CodeCheck,`; найти `import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";` и заменить на:

<!-- prettier-ignore -->
```tsx
import { WarehouseScreen } from "./warehouse/WarehouseScreen.js";
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";
```

(2) Найти:

<!-- prettier-ignore -->
```tsx
type Leave =
  | { kind: "list" }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" }
  | { kind: "setup"; shift: WorkShift };
```

и заменить на:

<!-- prettier-ignore -->
```tsx
type Leave =
  | { kind: "list" }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" }
  | { kind: "setup"; shift: WorkShift }
  // From the warehouse reprint to the workstation setup, and back to its session (plan СКЛ).
  | { kind: "warehouse_setup" };
```

(3) Найти:

<!-- prettier-ignore -->
```tsx
type FloorView =
  | { kind: "list" }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean; officeClosed: boolean }
  | { kind: "setup"; back: WorkShift | null };
```

и заменить на:

<!-- prettier-ignore -->
```tsx
type FloorView =
  | { kind: "list" }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean; officeClosed: boolean }
  // The warehouse reprint (plan СКЛ): no shift, its work gated like a shift's.
  | { kind: "warehouse"; leaving: boolean }
  | { kind: "setup"; back: WorkShift | "warehouse" | null };
```

(4) В `FloorAppProps` найти:

<!-- prettier-ignore -->
```tsx
  /** `HostApi.requestSsccBlock`: the work screen's serials for its boxes. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
```

и заменить на:

<!-- prettier-ignore -->
```tsx
  /** `HostApi.requestSsccBlock`: the work screen's serials for its boxes. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** `HostApi.warehouseLookup` (plan СКЛ); none — the list offers no warehouse reprint. */
  warehouseLookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
```

и в деструктуризации параметров найти `  requestBlock,\n  requestFacts,` и заменить на `  requestBlock,\n  warehouseLookup,\n  requestFacts,`.

(5) Найти в `finish`:

<!-- prettier-ignore -->
```tsx
    if (leave.kind === "setup") {
      setView({ kind: "setup", back: leave.shift });
      return;
    }
    setView({ kind: "list" });
  }, []);
```

и заменить на:

<!-- prettier-ignore -->
```tsx
    if (leave.kind === "setup") {
      setView({ kind: "setup", back: leave.shift });
      return;
    }
    if (leave.kind === "warehouse_setup") {
      setView({ kind: "setup", back: "warehouse" });
      return;
    }
    setView({ kind: "list" });
  }, []);
```

(6) Найти в `leave`:

<!-- prettier-ignore -->
```tsx
      if (current.current.view.kind !== "work") {
        finish(reason);
        return;
      }
```

и заменить на:

<!-- prettier-ignore -->
```tsx
      const from = current.current.view.kind;
      // The warehouse reprint's work is tracked by the same gate as a shift's (N9),
      // but it is no shift: the shell is told of no work entered or left.
      if (from !== "work" && from !== "warehouse") {
        finish(reason);
        return;
      }
```

найти

<!-- prettier-ignore -->
```tsx
      setView((now) => (now.kind === "work" ? { ...now, leaving: true } : now));
      void gate.drain().then(() => {
        const ending = standing.current ?? reason;
        standing.current = null;
        if (!alive.current) return;
        current.current.dispatch({ type: "work_left", sessionId });
        finish(ending);
      });
```

и заменить на:

<!-- prettier-ignore -->
```tsx
      setView((now) =>
        now.kind === "work" || now.kind === "warehouse" ? { ...now, leaving: true } : now,
      );
      void gate.drain().then(() => {
        const ending = standing.current ?? reason;
        standing.current = null;
        if (!alive.current) return;
        if (from === "work") current.current.dispatch({ type: "work_left", sessionId });
        finish(ending);
      });
```

(7) Найти в `backFromSetup`:

<!-- prettier-ignore -->
```tsx
    (back: WorkShift | null) => {
      if (back === null) {
        setView({ kind: "list" });
        return;
      }
```

и заменить на:

<!-- prettier-ignore -->
```tsx
    (back: WorkShift | "warehouse" | null) => {
      if (back === null) {
        setView({ kind: "list" });
        return;
      }
      if (back === "warehouse") {
        ending.current = false;
        setView({ kind: "warehouse", leaving: false });
        return;
      }
```

(8) Найти `  if (view.kind === "new_shift") {` и вставить перед ним:

<!-- prettier-ignore -->
```tsx
  if (view.kind === "warehouse" && warehouseLookup !== undefined) {
    return (
      <WarehouseScreen
        operator={operator}
        local={local}
        pairing={{ hostId, deviceId }}
        online={online}
        track={gate.track}
        touch={lock.touch}
        isLeaving={isLeaving}
        source={source}
        lookup={warehouseLookup}
        onHostError={hostError}
        onRecorded={recorded}
        printing={printing}
        onLeave={() => leave({ kind: "list" })}
        onSetup={() => leave({ kind: "warehouse_setup" })}
      />
    );
  }
```

(9) В `<ShiftList …>` после `onSetup={() => setView({ kind: "setup", back: null })}` добавить:

<!-- prettier-ignore -->
```tsx
      {...(warehouseLookup === undefined
        ? {}
        : {
            onWarehouse: () => {
              ending.current = false;
              setView({ kind: "warehouse", leaving: false });
            },
          })}
```

(10) В `apps/standalone/src/app/App.tsx` в `<FloorApp …>` найти `              requestBlock={hostApi.requestSsccBlock}` и заменить на `              requestBlock={hostApi.requestSsccBlock}\n              warehouseLookup={hostApi.warehouseLookup}`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-app.test.tsx test/floor-shift-list.test.tsx test/app.test.tsx` — PASS; затем `test/floor-app.test.tsx` под стендом с задержкой `setImmediate` — PASS; файлы стенда удалить.

- [ ] **Шаг 4: `AGENTS.md`.** В `apps/standalone/AGENTS.md` найти строку `## Shift exports` и вставить перед ней раздел:

<!-- prettier-ignore -->
```md
## Warehouse reprint

Plan СКЛ (pilot spec §30) ports the cloud station's «Складские операции →
Повторная печать этикеток» (#693/#695/#697) for one site. «Повторная печать
этикеток» on the list of shifts opens a session inside the operator's floor
session (PIN or badge, offline): its reason (`not_printed`, `damaged`, `lost`)
and a template for each kind of label (unit — `product_duplicate`, box,
pallet), chosen from this pairing's copies (`ref_templates`) with a search and
a sample preview; the organization's default (or the only enabled template)
is chosen at first. A session pauses on «К сменам» and is continued by the
next entry, by any operator; «Завершить сеанс» needs a confirmation and no
waiting job; a finished session is never continued (`wh_sessions_open`).

A scan or a typed code is read by the domain's warehouse rule
(`resolveWarehouseReprintScan`: a KM by its `kmHash`, an SSCC, and the old
TSPL label `!100` + SSCC repaired once, never anything looser) and looked up on
the host, `POST /v1/device/warehouse/lookup` (`routes/warehouse.rs`, any live
device, `{ codeHash }` or `{ sscc }`): the code's owner in `code_owners`, a
closed box by `boxes.sscc`, a closed pallet by `pallets.sscc`, of any station
and any shift; the label's fields come from the shift's snapshot, number and
production date, the record's own instant and counts and its operator's name,
and a unit's full canonical code (GS and crypto tail) comes only in the
answer's body. A code freed by an exception is `released`, a box or pallet
taken apart `disassembled`. Without the link nothing is looked up and the
screen says so; an old host (404) is «обновите хост»; a restored host holds the
route (`restore_pending`).

The station makes a job (`wh_jobs`, shell migration `0012`): the operator
checked against the copies, the template checked (enabled, readable, covering
the product's group; a unit's a valid duplicate layout, a box's or pallet's
with the SSCC and no KM), the printer of the kind (`duplicate`, `box`,
`pallet`), the bytes rendered by `renderLabel` (a unit's code as the GS1
raster) — the layout and fields frozen in the job. One job of a session waits
at a time (`wh_jobs_open`); a code the session printed is not printed again
without «Напечатать ещё раз» and a reason. `sending` is written before the
bytes go; a restart turns it into `unknown` (`interrupted`); a failed job is
retried (rendered again only for a printer of another language or
resolution) or cancelled; an unknown one is checked by a scan of the new label
(`compareWarehouseReprintLabel`, which never takes the old `!1` label) or
printed again with a reason. Nothing is ever sent again by itself.

Each attempt's outcome (`sent`, `unknown`, `failed`, `verified`,
`cancelled`) writes a record in `wh_outbox` in the same transaction; the link
sends them after the facts (`sendWarehouseBatch`) to `POST
/v1/device/warehouse/reprints`, which keeps one row per record in
`warehouse_reprints` (host migration `0015`): receipts as the facts', with
`invalid_record`, `payload_mismatch` and `subject_unknown`. A record names a
code's hash or an SSCC, never a full code; reprint records write no audit row
and take no revision, and change no box, pallet, code or SSCC. A finished
session whose records were all accepted goes 30 days after its finish
(`purgeWarehouseSessions`, in the hourly retention pass).

```

В разделе «Verification» найти строку `- Pallets of several stations on one shift and the revocation of pallet blocks` и вставить перед ней:

<!-- prettier-ignore -->
```md
- The warehouse reprint (plan СКЛ) by hand, on Windows 10 and 11, with the
  client's printers and scanners. None of it has been run; check at least:
  - a unit's label on the duplicate printer (ZPL and TSPL, 203 and 300 dpi):
    the printed Data Matrix scanned back gives the full code with its GS and
    crypto tail; a box's and a pallet's label with the original dates;
  - an old box label with `!1` scanned with the client's scanner: the new
    label carries the same SSCC without `!1`, and a scan of the old label
    does not confirm an unknown print;
  - the host's PC switched off: the screen says the code cannot be looked up;
    a print cut by pulling the printer's cable: «Неизвестно, вышла ли
    этикетка», the check by a scan of the new label, the records reaching the
    host once the link is back;
  - the template list on the touch panel with the on-screen keyboard over the
    search, and the screen at 1024 × 768 and 1280 × 800 (64 px controls).
```

- [ ] **Шаг 5: спецификация, раздел 30.** В конец `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` дописать:

<!-- prettier-ignore -->
```md

## 30. Уточнения плана СКЛ

План `docs/superpowers/plans/2026-10-11-standalone-skl-warehouse-reprint.md` (складская
повторная печать этикеток) переносит в автономную станцию облачный режим #693/#695/#697 и
снимает для него строку «перепечатка по коду» раздела 4.2 (решение владельца 2026-10-11).
Номер раздела — по распределению контроллера (24 — РК-С, 25 — ХП, 26 — I1, 27 — ОЧ, 28 — ДРВ,
29 — A4); при слиянии разделы нумеруются заново.

- **Где и кто.** Кнопка «Повторная печать этикеток» в списке смен; режим работает внутри сеанса
  оператора (PIN или бейдж, офлайн), без офисной сессии; перед каждой подготовкой оператор
  проверяется по копиям станции.
- **Что печатается.** Код единицы (Data Matrix полного кода с криптохвостом, назначение шаблона
  «Дубликат товара», принтер «Дубль кода»), этикетка короба и этикетка паллеты (термоэтикетка) —
  любой станции и любой смены площадки, закрытой тоже. Новые единицы, короба и SSCC не создаются;
  даты, количество и оператор — исторические, из записи хоста. Листы A4 паллеты — план A4.
- **Поиск — только на хосте** (`POST /v1/device/warehouse/lookup`). Без связи экран честно говорит,
  что найти код нельзя; код, снятый исключением, и расформированный короб или паллета не печатаются.
- **Сеанс:** причина (не напечаталась, повреждена, утеряна) и шаблоны на три типа из копий станции
  со списком, поиском и предпросмотром на образце; пауза «К сменам», продолжение при следующем
  входе, завершение с подтверждением и без нерешённой печати.
- **Печать:** одно задание за раз; повтор кода в сеансе — только «Напечатать ещё раз» с причиной;
  неизвестный исход не повторяется сам — проверка сканом новой этикетки (скан старой с `!1` её не
  подтверждает) или новая попытка с причиной; сбой до передачи — повтор или отмена.
- **След:** запись на каждую попытку уходит на хост (`POST /v1/device/warehouse/reprints`,
  таблица `warehouse_reprints`), идемпотентно, без кода маркировки (только хеш или SSCC).
- **Миграции:** оболочка `0012_warehouse_reprint.sql`, хост `0015_warehouse_reprints.sql`.
- **Не проверено:** Windows, принтеры клиента, обратный скан напечатанного Data Matrix,
  сенсорная панель — ручной список «Verification» в `apps/standalone/AGENTS.md`.
```

- [ ] **Шаг 6: итоговые проверки.**

Run (по порядку, из корня):

1. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — PASS (записать число файлов и тестов; падения тайм-аутом старых тестов офиса под нагрузкой разобрать отдельным прогоном файла, не повтором).
2. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`, `run lint`, `run build` — чисто.
3. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
4. `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`, `-p markiro-host`, `-p markiro-standalone --test local_db` — PASS; затем `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace` (если песочница не даёт целиком — по пакетам, записать).
5. `node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — чисто (для `apps/standalone` — только изменённые файлы, если проверка всего каталога долгая); `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`.
6. `grep -rn "console\." apps/standalone/src/floor/warehouse apps/standalone/src/local/warehouse-sender.ts` — пусто; `grep -n "tracing::" apps/standalone/host/src/routes/warehouse.rs` — одна строка (`a warehouse batch failed`, без значений записи).

- [ ] **Шаг 7: коммит.** `git add apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/app/App.tsx apps/standalone/test/floor-app.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`; сообщение `feat(standalone): open the warehouse reprint from the floor; docs and spec §30 (plan СКЛ task 8)` + трейлер. Если локальный граф есть (`graphify-out/graph.json`) — `graphify update .` (не коммитится).

---

## Итоговая проверка плана

- Требования задания покрыты: поиск по коду единицы и SSCC короба (и паллеты) любой станции и закрытой смены (задача 2); причина, шаблоны со списком, поиском и предпросмотром (задачи 5, 7); сеанс с паузой, завершением и продолжением (задачи 4, 7); проверка оператора (задача 5); след на хосте отдельным маршрутом (задачи 1, 3, 6); идемпотентность (задачи 3, 6) и офлайн (решение Р2, задачи 5–7); печать через существующую машинку и драйверный путь ДРВ без зависимости (Р14, задача 5); миграции по распределению (оболочка `0012`, хост `0015`).
- Задач — 8; каждая проверяется своими тестами и коммитится отдельно; задачи 1→2→3 и 4→5→6→7→8 идут по порядку, ветка хоста (2–3) и ветка станции (4–5) друг от друга не зависят, кроме протокола задачи 1.

## Перенесено

- Страница офиса с историей перепечаток (`warehouse_reprints` по `identity`, по сменам) и выгрузка следа — отдельный план офиса.
- Счёт неотправленных записей перепечатки в строке статуса станции и в проверке «забыть устройство» (`device_forget` считает только `outbox`): записи `wh_outbox` видны на экране режима; при «забыть» они остаются (класс `DeviceData`).
- Повторная отправка отказанных записей («Отправить снова») — правило плана ОЧ; сейчас отказ хранится с кодом.
- Перепечатка листов A4 паллеты и «Состав паллеты» — план A4.
- Локальный поиск без хоста (по своим `floor_boxes`/`floor_codes`) — не нужен одной площадке с хостом в сети цеха (Р2).
- Типовые шаблоны «только код» облака (`buildWarehouseCodeOnlyLabelTemplate`, `buildWarehouseCodeOnlyBoxTemplate`) в мастере и офисе — по запросу владельца.
- Ручное подтверждение «этикетка вышла» без скана для `unknown` — облако его не даёт; осталось так же.
- ТСД (`apps/handheld`) — складская перепечатка на терминале не входит.
- Подпись «Станция пока печатает только этикетки коробов» у назначений принтеров в «Рабочее место» устарела (паллеты и перепечатка печатают); правка текста — вместе с планом ДРВ, который меняет этот экран.

## Не проверено

- Ни один шаг плана не исполнялся на копии (скорость): фрагменты взяты из настоящего дерева `2c726efba`, код написан без прогона; исполнитель доводит до зелёных проверок и записывает отклонения.
- Windows 10/11, WebView2, сенсорная панель, экранная клавиатура над поиском шаблонов.
- Принтеры клиента (ZPL/TSPL, 203/300 dpi), растровый Data Matrix единицы на настоящей этикетке и её обратный скан; печать через драйвер Windows (план ДРВ).
- Старая этикетка с `!1`, отсканированная настоящим сканером (AIM-префиксы `]C0`/`]C1`).
- Хост на другом ПК по Wi-Fi: время поиска, обрыв связи посреди поиска и посреди передачи на принтер.
- Восстановление хоста из копии при ждущих записях перепечатки.

## Отклонения при исполнении
