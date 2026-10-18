# План 1e2: приложение — каталог: товары в офисе, слой протокола всего каталога, копии товаров, шаблонов и умолчаний на станции — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В офисе появляется раздел «Каталог» с экраном «Товары»: администратор и технолог ведут товары — GTIN с проверкой контрольной цифры и подсказкой, чей у него префикс, названия, товарную группу, вместимости, срок годности и шаблоны этикеток по умолчанию. Вебвью получает слой протокола всего каталога плана 1e1 (схемы Zod, сборщики тел, методы `HostApi`; каждую фикстуру 1e1 теперь читают и Rust, и Vitest), а станция хранит копии товаров, шаблонов и умолчаний категорий из ленты. Экраны шаблонов и умолчаний и мастер с типовыми шаблонами — план 1e3: этот план готовит им протокол.

**Architecture:**

- `src/lib/rules.ts` — правила полей товара, зеркало хоста: `gtinRule` и `toGtin14`, `countRule` и `toCount`, константы потолков. `src/lib/template-eligibility.ts` — правило слота `templateFitsSlot`: для короба и паллеты — правило `@markiro/domain`, для дубликата — то же правило здесь.
- `src/host/{protocol,requests,api}.ts` — схемы ответов и тел всего каталога, сборщики `productCreate`, `productUpdate`, `templateCreate`, `templateUpdate`, `templateDefaultsUpdate`, методы `HostApi`, необязательные `templates` мастера.
- `src-tauri/migrations/0004_catalog.sql`, `src/local/reference-sync.ts`, `src/host/protocol.ts` — копии `ref_products`, `ref_templates`, `ref_template_defaults` и три столбца шаблонов у `ref_org`; нестрогие записи ленты каталога с непрозрачным макетом; `SYNC_SCHEMA_VERSION` 4; защита upsert каталога от более новой записи карантина.
- `src/office/products/*` — страница «Товары» (список, поиск, отбор по состоянию, страницы) и диалог товара (добавление, правка, архив, подсказки о GTIN, шаблоны по умолчанию); `src/office/form-errors.ts` — `staleFields` у `writeFailure`.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, react-hook-form 7.85 и @hookform/resolvers 5.9, TanStack Query 5.101, i18next, `@markiro/ui` (`Table`, `FilterBar`, `Select` с `native`, `StatusChip`, `Checkbox`), `@markiro/domain` (`normalizeToGtin14`, `isValidGtin`, `gtinMatchesPrefix`, `isBoxLabelTemplateEligible`, `isPalletLabelTemplateEligible`), Vitest 4 с jsdom и `node:sqlite`; Rust — sqlx 0.8 (SQLite) в тестах оболочки.

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1e2-design.md`: границы плана и решения D1–D10; всё, что брифом не названо, — в «Перенесено».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §4.3 (каталог), §4.4 (лента), §4.5 (маршруты и фикстуры), §4.6 (ошибки), §4.8 (роли), §5.3 (локальная база), §5.4 (синхронизация), §5.5 (офис), §6 (контракт), §8 (строка 1e).
- План 1e1 (`docs/superpowers/plans/2026-10-03-standalone-1e1-host-catalog-templates.md`), его «Отклонения при исполнении» и «Перенесено» (пункты для плана 1e2); планы 1d3 и 1d4 — основа записи офиса, копии станции, карантин.
- Облако, с которого снят экран: `apps/admin/src/pages/catalog/{index,ProductForm}.tsx` и `apps/api/src/modules/products/products.service.ts` (`checkGtinOwner`).

## Global Constraints

**Решения контроллера** (обязательные; владелец может их пересмотреть)

- D1. Записи ленты каталога (`products`, `label_templates`, `category_template_defaults`) читаются нестрого, `z.object`: незнакомый ключ отбрасывается, как у `org_profile` и `lines`. Запись, не прошедшая схему (не тот тип, неизвестные `purpose` или `status`, идентификатор шаблона не UUID, GTIN не из 14 цифр), уходит в карантин общим кодом. `spec` — непрозрачный объект: `templateSpecSchema = z.custom(…)` (простой объект, не массив, не скаляр; одна проблема `custom`), никогда не `z.record` с динамическими ключами; макет при синхронизации не проверяется. Политика «строго или нестрого» в целом — плана 5.
- D2. Копии товарных групп на станции в плане 1e2 нет: её никто на станции не читает (`ref_products.chz_group_code` и умолчания категорий несут голые коды, заглушка цеха названий групп не показывает). Три варианта и повод — в «Перенесено». Потребителя, которого бриф упустил, планировщик не нашёл.
- D3. Правило слота дубликата — правило вебвью, домен не меняется: `templateFitsSlot(template, slot)` в `src/lib/template-eligibility.ts` отдаёт короб и паллету `isBoxLabelTemplateEligible` / `isPalletLabelTemplateEligible`, а дубликат проверяет так же (включён, назначение совпадает, категории покрывают; слот организации — категория `null`, ему нужен шаблон для всех категорий). Vitest читает все 12 случаев `proto/fixtures/template-eligibility.json`. `packages/domain` и `apps/station` не меняются.
- D4. Каждый upsert копии каталога (`products`, `label_templates`, `category_template_defaults`) несёт защиту `notQuarantinedNewer`; у каждой сущности свой тест на настоящем коде и своя мутация. `org_profile`, `lines` и `site` не дооснащаются (в «Перенесено»).
- D5. Слой протокола покрывает все формы каталога, в том числе тела шаблонов и умолчаний и методы `HostApi`, которые позовут только экраны плана 1e3 (`getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `getTemplateDefaults`, `updateTemplateDefaults`), и `templates` мастера. Каждый сборщик и метод проходит тест (`test/api.test.ts`, `test/protocol.test.ts`). Экран мастера и `wizard-form.ts` не меняются.
- D6. Копии хранят признаки (`archived`, `enabled`, `status`) и ничего не отбирают.
- D7. `SYNC_SCHEMA_VERSION` = 4: `ENTITY_SET` = `org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults;v4`.
- D8. «Товары» — урезанный перенос `apps/admin/src/pages/catalog`: без фото, Нацкаталога, разделов ЕГАИС и регуляторики, связей с 1С и плашки кандидатов, цены, контрагента по умолчанию, столбца статуса ЧЗ и удаления. Список приходит от хоста целиком, поэтому поиск, отбор и страницы — в вебвью.
- D9. Отказ `validation_failed` на `defaultBoxTemplateId` / `defaultPalletTemplateId` диалог товара принимает за устаревшую запись: то же предложение «Загрузить заново», что у `stale_revision`, правки пользователя отбрасываются. Как: `writeFailure(error, fields, conflicts, staleFields)` — четвёртый необязательный параметр, имена полей хоста, чей `validation_failed` отвечает `{ kind: "stale" }`; у товара это `PRODUCT_STALE_FIELDS`. Уточнение плана: «Загрузить заново» сразу перечитывает список товаров, а список шаблонов перечитывается при следующем открытии диалога — диалог читает шаблоны при каждом открытии (`staleTime` 0), и отдельный сброс кэша не нужен (тест закрепляет второе чтение).
- D10. Мёртвого интерфейса нет: кнопки записи закрыты `useCan("editCatalog")`, отдельного вида «только чтение» нет. Проверка: тест для обеих ролей видит «Добавить товар» и «Изменить», мутация «закрыть по `editReference`» его роняет; обратная сторона недостижима — роли без `editCatalog` нет.

**Роли** (спецификация §4.8)

- Обе роли офиса читают и пишут каталог (`useCan("editCatalog")` верно для обеих); пункт «Товары» в разделе «Каталог» `OFFICE_NAV` — `roles: ["admin", "technologist"]`, маршрут `/products` без `RequireRole`. Права проверяет хост.

**Правила полей товара** (зеркало `host/src/validate.rs` и `@markiro/domain`)

| Поле                                     | Правило                                                                                                                                                                                                              | Текст ошибки                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| GTIN (`gtin14`)                          | `gtinRule`: после `trim` — `^(?:[0-9]{8}\|[0-9]{12,14})$` (ASCII-цифры), затем `isValidGtin` (контрольная цифра); уходит `toGtin14` = `normalizeToGtin14` — 14 цифр с ведущими нулями; хост проверяет только 14 цифр | длина или знак — `rules.gtin`, цифра — `rules.gtinCheckDigit` |
| Название (`name`)                        | `productNameRule` = `plainTextRule(200, …)`: 1–200 символов, без управляющих символов и одиночных суррогатов                                                                                                         | длина — `rules.productName`, знак — `rules.controlCharacter`  |
| Название для печати (`printName`)        | `printNameRule` = `optionalTextRule(200, …)`: до 200 символов, пусто — `null` (`toOptionalText`)                                                                                                                     | длина — `rules.printName`, знак — `rules.controlCharacter`    |
| В коробе (`boxCapacity`)                 | `countRule(MAX_BOX_CAPACITY)`: пусто — `null`, иначе `^[1-9][0-9]*$` и не больше 100 000 (`toCount`)                                                                                                                 | `rules.boxCapacity`                                           |
| Коробов на паллете (`palletBoxCapacity`) | `countRule(MAX_PALLET_BOX_CAPACITY)`: пусто — `null`, иначе 1–10 000                                                                                                                                                 | `rules.palletBoxCapacity`                                     |
| Срок годности (`shelfLifeDays`)          | `countRule(MAX_SHELF_LIFE_DAYS)`: пусто — `null`, иначе 1–3650                                                                                                                                                       | `rules.shelfLifeDays`                                         |
| Товарная группа (`chzProductGroupCode`)  | `productGroupRule`: значение выбора — `""` (нет группы, `null`) или код `^[1-9][0-9]*$` (`toGroupCode`); существование проверяет хост                                                                                | `rules.productGroup`                                          |

- Константы — `MAX_BOX_CAPACITY = 100_000`, `MAX_PALLET_BOX_CAPACITY = 10_000`, `MAX_SHELF_LIFE_DAYS = 3_650`, `MAX_PRODUCT_NAME = 200` в `src/lib/rules.ts`, зеркало `validate::MAX_BOX_CAPACITY` и соседних; тест держит их значения.
- Числа проверяются как текст до превращения в число: `Number` принимает `1e3`, `0x10`, `12.0` и ` 12`, а `\d` без флага `u` — только ASCII; поэтому `[0-9]` и `[1-9]`, без знака и ведущего нуля.
- `status` товара вычисляет хост (`active` — есть группа и обе вместимости, иначе `draft`); его никто не шлёт.

**Ошибки хоста** (спецификация §4.6)

- `validation_failed` с `details.field` `gtin14`, `name`, `printName`, `chzProductGroupCode`, `boxCapacity`, `palletBoxCapacity`, `shelfLifeDays` — под своё поле, текст `rules.rejected` (`PRODUCT_FIELDS`).
- `conflict` с `details.constraint: gtin14` — под GTIN, `office.products.errors.gtinTaken` (`PRODUCT_CONFLICTS`): при добавлении, смене GTIN и возврате из архива.
- `stale_revision` и (D9) `validation_failed` на `defaultBoxTemplateId` или `defaultPalletTemplateId` (`PRODUCT_STALE_FIELDS`) — «Загрузить заново» (`WriteFailureAlert` с `onReload`).
- Всё остальное — предупреждение с текстом по коду (`errorMessageKey`).

**Тела запросов** (`src/host/requests.ts`; каждое собирает свой сборщик поле за полем из обрезанных значений, которые приняла форма, — никогда не разворотом; идентификаторы — только в пути, в ответах читаются как `z.uuid()`)

| Сборщик                                          | Тело                                                                                                                                                                                                                                                                           | Фикстура                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `productCreate(product: ProductInput)`           | все девять полей, `null` за пустое                                                                                                                                                                                                                                             | `product-create.json`           |
| `productUpdate(product, archived, expectedRev)`  | запись целиком, `archived` и `expectedRev`; `null` очищает поле                                                                                                                                                                                                                | `product-update.json`           |
| `templateCreate(template: TemplateInput)`        | `name`, `purpose`, `enabled`, `chzProductGroupCodes` (`null` — все категории), `spec`                                                                                                                                                                                          | `template-create.json`          |
| `templateUpdate(template, next: TemplateChange)` | только отличающиеся от загруженного `name` и `enabled`, категории в трёх состояниях (нет поля — оставить, `null` — все категории, список — эти, порядок важен), `spec` — всякий раз, когда передан; всегда `expectedRev`; `null` в `name`, `enabled`, `spec` не шлётся никогда | `template-update.json`          |
| `templateDefaultsUpdate(defaults, expectedRev)`  | документ целиком: три умолчания организации (`null` — нет) и все умолчания категорий                                                                                                                                                                                           | `template-defaults-update.json` |

- Схемы ответов — нестрогий `z.object`; схемы тел — `.strict()`. `bootstrapRequestSchema` получает необязательный `templates: z.array(stockTemplateSchema).optional()`, `stockTemplateSchema` — `{ name, purpose, spec, orgDefault? }`; `null` в `templates` и `orgDefault` хост не принимает, схема тоже. Мастер собирает тело на месте, как прежде (фикстуру `bootstrap-request-templates.json` проверяет строгая схема).
- `deleteTemplate` — `DELETE`, ответ 204 разбирает прежний `NO_CONTENT`. Отказ `template_is_default` разбирает общий `errorBodySchema` (`details` с `constraint`, `organizationDefault`, `categoryDefaults`).

**Запись в диалогах** (уроки планов 1d3 и 1d4)

- В `try` — только ожидаемая запись; тело собирается до `try`, `onSaved` — после `try/catch`, каждый `catch` кончается `return`. Тело строится из выхода схемы Zod (обрезанные значения), `raw` у `zodResolver` не ставится.
- Два щелчка, которые должны быть одновременными, — в одном `act`. `withRecord` (`useStoreRecord`) заменяет запись на месте, новая добавляется в конец; таблица сортирует при выводе.

**Копии станции** (`src-tauri/migrations/0004_catalog.sql`)

- `ALTER TABLE ref_org ADD COLUMN default_box_template_id TEXT` и так же `default_pallet_template_id`, `default_duplicate_template_id`.
- `ref_products(id PK, gtin14, name, print_name, chz_group_code, box_capacity, pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status, rev)`, индекс `ref_products_gtin14`.
- `ref_templates(id PK, name, purpose, enabled, category_codes, stock, spec, rev)`: `category_codes` — текст JSON массива или `NULL` (все категории), `spec` — макет текстом JSON.
- `ref_template_defaults(id PK = ключ ленты <код>:<назначение>, chz_group_code, purpose, template_id, rev)`.
- Ни внешних ключей, ни `UNIQUE` (кроме первичного ключа), ни `CHECK` в копиях: нарушение сорвало бы всю порцию и остановило синхронизацию навсегда; надгробие удалённого шаблона приходит раньше товаров, у которых снята ссылка; шаблон может ждать в карантине; у архивного товара тот же GTIN, что у товара в работе. Шапка миграции `0001` («products and templates join with plans 1d and 1e») остаётся как есть: применённую миграцию не редактируют.
- `clear_copies` очищает новые таблицы сам (`pragma_table_list`); тест `clearing_the_copies_empties_every_table_but_the_migration_journal` получает строки в трёх новых таблицах.
- Бюджет порции — 3E + 6 SQL-операторов: при E = 8 это 30 из 32 оболочки; тест строит худшую порцию.
- `->>` превращает JSON `true`/`false` в 1/0, массив и объект — в их текст JSON, `null` — в SQL `NULL`. Текст `spec` в копии — то, что даёт `JSON.stringify` разобранного макета (ключи-целые числа — первыми), не байтовый порядок хоста: всё, что считает дайджест макета (план 2a), сначала его канонизирует.
- Ограничения оболочки считают текст SQL (64 КБ) и число значений (256), а не размер одного значения: ревизия больше 1 МиБ приходит одним параметром JSON на сущность (новый тест `one_value_of_a_few_mebibytes_passes_the_limits`).

**Тексты**

- Каждый видимый текст — ключ `src/i18n/ru.json`; тексты даны в шагах задач целиком и переносятся буква в букву. Кавычки — «ёлочки».
- Новые ключи: `rules.gtin`, `rules.gtinCheckDigit`, `rules.productName`, `rules.printName`, `rules.boxCapacity`, `rules.palletBoxCapacity`, `rules.shelfLifeDays`, `rules.productGroup` (задача 1); `office.nav.sections.catalog`, `office.nav.products`, группа `office.products.*` (задачи 4–6). Прежние тексты не меняются.

**Решения планировщика** (открытые места брифа)

- Название для печати — второй строкой «Для печати: …» и только когда отличается от названия: словами, не одним цветом.
- Размер страницы — постоянные 25 строк, без выбора: каталог площадки — десятки, редко сотни товаров, а поиск сужает список.
- Смена группы в форме не сбрасывает шаблон, который перестал подходить: он остаётся отмеченным «— не подходит» и уходит, пока его не сменили (хост его принимает, а молчаливый сброс стёр бы выбор, которого пользователь не трогал).
- Индекс — только `ref_products(gtin14)`: план 2a ищет отсканированный товар по GTIN; шаблоны и умолчания ищутся по ключу, умолчаний не больше 153 строк.
- GTIN — два сообщения: у домена один код ошибки (`GTIN_INVALID`) на длину и цифру, поэтому правило само проверяет длину раньше; тест держит согласие с `isValidGtin`.
- «GTIN» латиницей, как «GLN» в этом приложении (облако пишет «ГТИН»).
- Три `default…TemplateId` записи организации — в задаче 3 вместе со своими столбцами `ref_org`, а не в задаче 2 (как предлагал бриф): схема и её хранение проверяются одним тестом старого хоста.
- `officeKeys.templates` и `useTemplates` появляются в задаче 6 вместе с первым читателем; в задаче 4 — только `products` и `productGroups`.
- Умолчание категории — одна схема `categoryTemplateDefaultSchema` на элемент документа умолчаний и запись ленты: в `proto` это один тип `CategoryTemplateDefault`.
- Подсказка владельца GTIN берёт контрагентов действующими первыми, по названию (`activeFirstByName`); облако идёт по времени создания, а у контрагента хоста времени создания нет.
- Список групп в форме — по названию (русский порядок): так группу найти легче, чем по коду.
- Утверждение «ограничения не считают размер значения» закреплено новым тестом Rust, раньше его не было.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля в `src/`); у полей подписи, у кнопок в строках — `aria-label` с названием товара, состояние — словом (`StatusChip`); вариант `destructive` здесь не нужен (удаления нет, архив — флажок в форме).
- Новых зависимостей нет — ни JS, ни Rust. `apps/station`, `packages/*`, хост (`apps/standalone/host`) и `apps/standalone/proto` не меняются; оболочка (`src-tauri`) — только миграцией `0004_catalog.sql` и тестами `src-tauri/tests/local_db.rs`.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в файле он встречается один раз (план применён к копии репозитория по шагам). Правки внутри шага идут сверху вниз по файлу, одна за другой. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Create» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`. Намеренные экранирования управляющих знаков и суррогатов в тестах (`"\t"`, `"\u0000"`, `"\ud800"`) стоят в блоках именно так.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> "$TMPDIR/before"` и `shasum -a 256 <файл>`; правка из блока; команда из блока — ожидаемый FAIL с названным сообщением; затем `cp "$TMPDIR/before" <файл>`, `cmp "$TMPDIR/before" <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD.
- В задаче 3 (Rust) — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.
- `git diff --check`.

**pnpm, cargo, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Cargo — с `--offline`; если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы. Оболочка (`src-tauri`) встраивает `apps/standalone/dist`: перед cargo соберите вебвью (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`). Отдельные наборы выбираются `--workspace --test <имя>`, не `-p`: выбор пакета меняет объединение признаков крейтов и пересобирает зависимости.
- Тесты, которые слушают 127.0.0.1, — только вне песочницы: `host/tests/hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, `changes_stream.rs`, `pairing.rs`, `pairing_codes.rs` и все `src-tauri/tests/*.rs`, кроме `local_db.rs`. Поэтому `cargo test --workspace` целиком идёт вне песочницы, а `--test local_db` — и в ней.
- React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от эффекта, — скрытый флейк. Ждать эффект явно (`waitFor`), «ровно N раз» проверять так: `waitFor`, два хода `await new Promise((resolve) => setImmediate(resolve))`, снова та же проверка. Два щелчка, которые должны быть одновременными, — в одном `act`.
- i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`), поэтому опечатка в ключе роняет тест, а не показывает ключ.
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст (нет предупреждений `act(...)` и ошибок React).
- Те же файлы один раз запускаются под стендом с задержкой `setImmediate` на 3 мс: он делает флейк эффекта постоянным. Стенд — два временных файла внутри пакета (из `$TMPDIR` Vite не грузит); запустить и сразу удалить, до `lint`:

  `apps/standalone/test/delayed-immediate.setup.ts`:

  ```ts
  // Temporary stand (never committed): React's scheduler runs passive effects
  // through `setImmediate`; delaying it by 3 ms makes every effect lose the race
  // with Testing Library's `setTimeout(0)`, so an assertion that depends on an
  // effect right after `findBy*` fails every time instead of now and then.
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setImmediate", {
    configurable: true,
    writable: true,
    value: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      realSetTimeout(callback, 3, ...args),
  });
  ```

  `apps/standalone/vitest.delay.config.ts`:

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

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`, затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`.

**Счёт тестов**

- До плана: Vitest — 37 файлов, 813 тестов; cargo — 41 набор, 452 теста (хост 307, `proto` 39, оболочка 106). Каждое «Expected» ниже выведено из этих чисел; расхождение значит, что шаг применён не так.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/src/lib/rules.ts, test/rules.test.ts                                         задача 1
apps/standalone/src/lib/template-eligibility.ts, test/template-eligibility.test.ts           задача 1
apps/standalone/src/host/protocol.ts, test/protocol.test.ts                                  задачи 2, 3
apps/standalone/src/host/{requests,api}.ts, test/api.test.ts, test/support/office.tsx        задача 2
apps/standalone/src-tauri/migrations/0004_catalog.sql, src-tauri/tests/local_db.rs           задача 3
apps/standalone/src/local/reference-sync.ts, test/{reference-sync,local-executor}.test.ts    задача 3
apps/standalone/src/office/{nav.ts,routes.tsx}, products/product-list.ts                     задача 4
apps/standalone/test/products-page.test.tsx                                                  задача 4
apps/standalone/src/office/office-query.ts, products/product-queries.ts                      задачи 4, 6
apps/standalone/src/office/products/ProductsPage.tsx                                         задачи 4, 5
apps/standalone/src/office/products/{ProductDialog.tsx,product-form.ts}                      задачи 5, 6
apps/standalone/test/product-dialog.test.tsx                                                 задачи 5, 6
apps/standalone/src/office/products/template-options.ts                                      задача 6
apps/standalone/src/office/form-errors.ts, test/form-errors.test.ts                          задача 6
apps/standalone/src/app/shell.css                                                            задачи 4, 5
apps/standalone/src/i18n/ru.json                                                             задачи 1, 4–6
apps/standalone/AGENTS.md                                                                    задачи 1–6
спецификация: §4.5 — задачи 1, 3; §4.4, §5.3, §5.4, §6 — задача 3; §5.5 — задачи 4–6
```

Правила полей и правило слота идут первыми: экранов у них нет, а берут их задачи 5 и 6. Слой протокола (задача 2) нужен и странице, и синхронизации; записи ленты стоят в задаче 3 рядом с копиями, которые они наполняют, — схема записи организации проверяется тем же тестом старого хоста, что и её столбцы `ref_org`. Страница (задача 4) приходит без кнопок записи: кнопки и диалог появляются вместе в задаче 5, поэтому мёртвых кнопок нет ни на одном коммите. Шаблоны по умолчанию и отказ по удалённому шаблону (задача 6) опираются на правило слота задачи 1, на метод `listTemplates` задачи 2 и на диалог задачи 5; задача 6 заканчивается сверкой документов. Итоговые ворота — в «Итоговой проверке плана».

---

### Task 1: Правила полей товара и правило слота шаблона

Правила формы товара — зеркало проверок хоста (`host/src/validate.rs`: `gtin14`, `product_name`, `print_name`, `count`) и правило GTIN домена: хост принимает любые 14 цифр, а контрольную цифру проверяет вебвью (`isValidGtin`), как облако. У домена один код ошибки на длину и цифру, поэтому длину правило проверяет само, раньше цифры, и говорит о них разными словами. Числа проверяются как текст до превращения в число: `Number` принимает `1e3`, `0x10` и `12.0`, целое хоста — нет.

Правило слота (D3) — `templateFitsSlot` в новом `src/lib/template-eligibility.ts`: короб и паллету решает домен, дубликат — то же правило здесь. Тест читает все 12 случаев `proto/fixtures/template-eligibility.json`, которые читает и `host/tests/templates.rs`, поэтому вебвью и хост отвечают одинаково. Экранов в задаче нет; правила берут задачи 5 и 6.

**Files:**

- Create: `apps/standalone/src/lib/template-eligibility.ts`
- Modify: `apps/standalone/src/lib/rules.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/rules.test.ts`, `apps/standalone/test/template-eligibility.test.ts` (Create)
- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates»), спецификация §4.5

**Interfaces:**

- Consumes:
  - `plainTextRule(max, message)`, `optionalTextRule(max, message)`, `toOptionalText(text)` — `src/lib/rules.ts`;
  - `isValidGtin`, `normalizeToGtin14`, `isBoxLabelTemplateEligible`, `isPalletLabelTemplateEligible`, `type LabelTemplatePurpose` — `@markiro/domain`.
- Produces (`src/lib/rules.ts`):
  - `MAX_BOX_CAPACITY = 100_000`, `MAX_PALLET_BOX_CAPACITY = 10_000`, `MAX_SHELF_LIFE_DAYS = 3_650`, `MAX_PRODUCT_NAME = 200`;
  - `gtinRule: z.ZodString` (сообщения `rules.gtin`, `rules.gtinCheckDigit`), `toGtin14(gtin: string): string`;
  - `productNameRule`, `printNameRule` (сообщения `rules.productName`, `rules.printName`, `rules.controlCharacter`);
  - `countRule(max: number, message: string): z.ZodString`, `toCount(text: string): number | null`, `boxCapacityRule`, `palletBoxCapacityRule`, `shelfLifeDaysRule` (сообщения `rules.boxCapacity`, `rules.palletBoxCapacity`, `rules.shelfLifeDays`);
  - `productGroupRule` (значение выбора `""` или код; сообщение `rules.productGroup`), `toGroupCode(value: string): number | null`.
- Produces (`src/lib/template-eligibility.ts`):
  - `interface TemplateScope { purpose: LabelTemplatePurpose; enabled: boolean; chzProductGroupCodes: readonly number[] | null }`;
  - `interface TemplateSlot { purpose: LabelTemplatePurpose; chzProductGroupCode: number | null }`;
  - `templateFitsSlot(template: TemplateScope, slot: TemplateSlot): boolean`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  badgeCodeRule,
  badgeLabelRule,
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  isPlainText,
  isTransferable,
  lineNameRule,
  loginRule,
  operatorLoginRule,
  operatorRoleRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  parsePrefixList,
  passwordRule,
  personNameRule,
  pinRule,
  toOptionalText,
  toOrgInput,
  type OrgFields,
```

заменить на

<!-- prettier-ignore -->
```ts
import { isValidGtin } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  badgeCodeRule,
  badgeLabelRule,
  boxCapacityRule,
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  gtinRule,
  innRule,
  isPlainText,
  isTransferable,
  lineNameRule,
  loginRule,
  MAX_BOX_CAPACITY,
  MAX_PALLET_BOX_CAPACITY,
  MAX_PRODUCT_NAME,
  MAX_SHELF_LIFE_DAYS,
  operatorLoginRule,
  operatorRoleRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  palletBoxCapacityRule,
  parsePrefixList,
  passwordRule,
  personNameRule,
  pinRule,
  printNameRule,
  productGroupRule,
  productNameRule,
  shelfLifeDaysRule,
  toCount,
  toGroupCode,
  toGtin14,
  toOptionalText,
  toOrgInput,
  type OrgFields,
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

/** The first message `rule` gives for `text`; `undefined` when it accepts the text. */
function message(rule: z.ZodString, text: string): string | undefined {
  return rule.safeParse(text).error?.issues[0]?.message;
}

describe("product rules", () => {
  it("pins the host's caps: 100 000 units a box, 10 000 boxes a pallet, 3650 days, 200 characters", () => {
    expect(MAX_BOX_CAPACITY).toBe(100_000);
    expect(MAX_PALLET_BOX_CAPACITY).toBe(10_000);
    expect(MAX_SHELF_LIFE_DAYS).toBe(3_650);
    expect(MAX_PRODUCT_NAME).toBe(200);
  });

  it("takes a GTIN of 8, 12, 13 or 14 ASCII digits with a valid check digit, trimmed", () => {
    for (const gtin of ["96385074", "036000291452", "4600682000013", "04600682000013"]) {
      expect(message(gtinRule, gtin), gtin).toBeUndefined();
    }
    expect(gtinRule.safeParse(" 4600682000013 ").data).toBe("4600682000013");
  });

  it("says a wrong length or a character that is no ASCII digit in one message", () => {
    // 9, 10 and 11 digits are no GTIN length; 7 and 15 lie outside them.
    for (const gtin of [
      "",
      "4600682",
      "460068200",
      "4600682000",
      "46006820000",
      "460068200001304",
      "460068200001A",
      "4600682 000013",
      "+4600682000013",
      "４６００６８２００００１３",
      "٤٦٠٠٦٨٢٠٠٠٠١٣",
    ]) {
      expect(message(gtinRule, gtin), gtin).toBe("rules.gtin");
    }
  });

  it("says a wrong check digit in its own message", () => {
    for (const gtin of ["4600682000010", "04600682000010", "96385075", "036000291453"]) {
      expect(message(gtinRule, gtin), gtin).toBe("rules.gtinCheckDigit");
    }
  });

  it("accepts exactly what the domain's normalizeToGtin14 accepts", () => {
    for (const gtin of [
      "96385074",
      "96385070",
      "036000291452",
      "4600682000013",
      "4600682000020",
      "04600682000020",
      "00000096385074",
      "1234567",
      "4600682000013 ",
    ]) {
      expect(gtinRule.safeParse(gtin).success, gtin).toBe(isValidGtin(gtin.trim()));
    }
  });

  it("saves a GTIN as its 14 digits, zero-padded", () => {
    expect(toGtin14("4600682000013")).toBe("04600682000013");
    expect(toGtin14(" 96385074 ")).toBe("00000096385074");
    expect(toGtin14("036000291452")).toBe("00036000291452");
    expect(toGtin14("04600682000013")).toBe("04600682000013");
  });

  it("takes a name of 1 to 200 characters and a print name of up to 200, blank as none", () => {
    expect(message(productNameRule, "я".repeat(200))).toBeUndefined();
    expect(message(productNameRule, "😀".repeat(200))).toBeUndefined();
    expect(message(productNameRule, "я".repeat(201))).toBe("rules.productName");
    expect(message(productNameRule, "  ")).toBe("rules.productName");
    expect(message(productNameRule, "Молоко\t3,2%")).toBe("rules.controlCharacter");
    expect(printNameRule.safeParse("   ").data).toBe("");
    expect(toOptionalText("   ")).toBeNull();
    expect(message(printNameRule, "я".repeat(200))).toBeUndefined();
    expect(message(printNameRule, "я".repeat(201))).toBe("rules.printName");
    expect(message(printNameRule, "Молоко\u0000")).toBe("rules.controlCharacter");
  });

  it.each([
    ["boxCapacityRule", boxCapacityRule, MAX_BOX_CAPACITY, "rules.boxCapacity"],
    [
      "palletBoxCapacityRule",
      palletBoxCapacityRule,
      MAX_PALLET_BOX_CAPACITY,
      "rules.palletBoxCapacity",
    ],
    ["shelfLifeDaysRule", shelfLifeDaysRule, MAX_SHELF_LIFE_DAYS, "rules.shelfLifeDays"],
  ] as const)("%s takes a whole number from 1 to its cap, or nothing", (_name, rule, max, key) => {
    for (const text of ["", "   ", "1", " 12 ", String(max)]) {
      expect(message(rule, text), text).toBeUndefined();
    }
    // `Number` would take most of these; the host's integer takes none.
    for (const text of [
      "0",
      String(max + 1),
      "012",
      "+12",
      "-1",
      "1e3",
      "0x10",
      "12.0",
      "1,5",
      "1 2",
      "１２",
      "١٢",
      "9".repeat(400),
    ]) {
      expect(message(rule, text), text).toBe(key);
    }
  });

  it("turns an accepted count into the number the host takes, and blank into none", () => {
    expect(toCount("")).toBeNull();
    expect(toCount("  ")).toBeNull();
    expect(toCount(" 12 ")).toBe(12);
    expect(toCount("100000")).toBe(100_000);
  });

  it("takes no product group, or a group's code from the select", () => {
    for (const value of ["", "8", "59"]) {
      expect(message(productGroupRule, value), value).toBeUndefined();
    }
    for (const value of ["0", "08", "8a", " 8", "-1"]) {
      expect(message(productGroupRule, value), value).toBe("rules.productGroup");
    }
    expect(toGroupCode("")).toBeNull();
    expect(toGroupCode("15")).toBe(15);
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
```

3. Create `apps/standalone/test/template-eligibility.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { templateFitsSlot, type TemplateScope } from "../src/lib/template-eligibility.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

const purposeSchema = z.enum(["box", "pallet", "product_duplicate"]);

/**
 * `proto/fixtures/template-eligibility.json`, read strictly: a key the host's
 * side adds to a case fails here, so the two sides never test different things.
 */
const ELIGIBILITY = z
  .strictObject({
    cases: z.array(
      z.strictObject({
        template: z.strictObject({
          purpose: purposeSchema,
          enabled: z.boolean(),
          chzProductGroupCodes: z.array(z.number().int()).nullable(),
        }),
        slot: z.strictObject({
          purpose: purposeSchema,
          chzProductGroupCode: z.number().int().nullable(),
        }),
        fits: z.boolean(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/template-eligibility.json", testModuleUrl), "utf8"),
    ),
  );

describe("template eligibility: the fixture the host's templates::fits answers too", () => {
  it("holds twelve cases, with a slot of every purpose", () => {
    expect(ELIGIBILITY.cases).toHaveLength(12);
    expect(new Set(ELIGIBILITY.cases.map((each) => each.slot.purpose))).toEqual(
      new Set(["box", "pallet", "product_duplicate"]),
    );
  });

  it.each(ELIGIBILITY.cases.map((each, index) => [index, each] as const))(
    "answers case %i as the host does",
    (_index, each) => {
      expect(templateFitsSlot(each.template, each.slot)).toBe(each.fits);
    },
  );
});

describe("template eligibility of a product duplicate, which the domain has no rule for", () => {
  const SCOPED: TemplateScope = {
    purpose: "product_duplicate",
    enabled: true,
    chzProductGroupCodes: [15],
  };

  it("takes an enabled duplicate template that covers the category, and no other", () => {
    expect(
      templateFitsSlot(SCOPED, { purpose: "product_duplicate", chzProductGroupCode: 15 }),
    ).toBe(true);
    expect(templateFitsSlot(SCOPED, { purpose: "product_duplicate", chzProductGroupCode: 8 })).toBe(
      false,
    );
  });

  it("needs a template for every category in the organization's slot", () => {
    expect(
      templateFitsSlot(SCOPED, { purpose: "product_duplicate", chzProductGroupCode: null }),
    ).toBe(false);
    expect(
      templateFitsSlot(
        { ...SCOPED, chzProductGroupCodes: null },
        { purpose: "product_duplicate", chzProductGroupCode: null },
      ),
    ).toBe(true);
  });

  it("takes no template of another purpose, and puts a duplicate template in no other slot", () => {
    expect(
      templateFitsSlot(
        { ...SCOPED, purpose: "box" },
        { purpose: "product_duplicate", chzProductGroupCode: 15 },
      ),
    ).toBe(false);
    expect(templateFitsSlot(SCOPED, { purpose: "box", chzProductGroupCode: 15 })).toBe(false);
    expect(templateFitsSlot(SCOPED, { purpose: "pallet", chzProductGroupCode: 15 })).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/template-eligibility.test.ts`
Expected: FAIL — `test/template-eligibility.test.ts` не загружается: `Failed to resolve import "../src/lib/template-eligibility.js"`; в `test/rules.test.ts` 12 из 46 тестов падают (все новые): `TypeError: Cannot read properties of undefined (reading 'safeParse')`, `toGtin14 is not a function`, `toCount is not a function`, `expected undefined to be 100000`.

- [ ] **Step 3: Правила и правило слота**

1. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { hasValidCheckDigit } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { hasValidCheckDigit, isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
```

2. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  timeZone: "timeZone",
};

```

заменить на

<!-- prettier-ignore -->
```ts
  timeZone: "timeZone",
};

// --- Products (plan 1e1's `validate.rs`, and the domain's GTIN rule) ---

/**
 * The host's caps (`validate::MAX_BOX_CAPACITY`, `MAX_PALLET_BOX_CAPACITY`):
 * the cloud bounds neither capacity, so these only keep a typing slip out of
 * production.
 */
export const MAX_BOX_CAPACITY = 100_000;
export const MAX_PALLET_BOX_CAPACITY = 10_000;
/** The longest shelf life in days: the cloud's bound, `validate::MAX_SHELF_LIFE_DAYS`. */
export const MAX_SHELF_LIFE_DAYS = 3_650;
/** The longest product name and print name, in characters (`validate::product_name`). */
export const MAX_PRODUCT_NAME = 200;

/**
 * What `normalizeToGtin14` takes before it checks the digit: 8, 12, 13 or 14
 * ASCII digits. The domain throws one `GTIN_INVALID` for a wrong length and a
 * wrong check digit alike, so the rule checks the length itself first and
 * says each in its own words.
 */
const GTIN_DIGITS = /^(?:[0-9]{8}|[0-9]{12,14})$/;

/**
 * A product's GTIN as typed: trimmed, 8, 12, 13 or 14 ASCII digits
 * (`rules.gtin`) with a valid GS1 check digit (`rules.gtinCheckDigit`). The
 * host checks only that 14 digits arrive (`validate::gtin14`); the form sends
 * `toGtin14` of the value.
 */
export const gtinRule = z
  .string()
  .trim()
  .regex(GTIN_DIGITS, "rules.gtin")
  .refine((gtin) => !GTIN_DIGITS.test(gtin) || isValidGtin(gtin), "rules.gtinCheckDigit");

/** The 14 digits a GTIN `gtinRule` accepted is saved as: zero-padded by `normalizeToGtin14`. */
export function toGtin14(gtin: string): string {
  return normalizeToGtin14(gtin.trim());
}

/** A product's name (`validate::product_name`): 1 to 200 characters. */
export const productNameRule = plainTextRule(MAX_PRODUCT_NAME, "rules.productName");

/** A product's print name (`validate::print_name`): up to 200 characters, blank for none. */
export const printNameRule = optionalTextRule(MAX_PRODUCT_NAME, "rules.printName");

/** A whole number as typed: ASCII digits with no sign, leading zero, point, comma or exponent. */
const WHOLE_NUMBER = /^[1-9][0-9]*$/;

/**
 * An optional count as typed (`validate::count`): blank for none, otherwise a
 * whole number from 1 to `max`. The text is checked as text before it becomes
 * a number: `Number` takes `1e3`, `0x10` and `12.0`, which the host's integer
 * does not. `toCount` turns an accepted value into the number.
 */
export function countRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => text === "" || (WHOLE_NUMBER.test(text) && Number(text) <= max), message);
}

/** An optional count `countRule` accepted, as the host takes it: `null` when blank. */
export function toCount(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

/** Units in a box: 1 to `MAX_BOX_CAPACITY`, or none. */
export const boxCapacityRule = countRule(MAX_BOX_CAPACITY, "rules.boxCapacity");

/** Boxes on a pallet: 1 to `MAX_PALLET_BOX_CAPACITY`, or none. */
export const palletBoxCapacityRule = countRule(MAX_PALLET_BOX_CAPACITY, "rules.palletBoxCapacity");

/** A shelf life in days: 1 to `MAX_SHELF_LIFE_DAYS`, or none. */
export const shelfLifeDaysRule = countRule(MAX_SHELF_LIFE_DAYS, "rules.shelfLifeDays");

/**
 * A product group as the form's select holds it: `""` for none, or a group's
 * code. The select offers only the host's groups and the product's own code,
 * and the host refuses a code it does not know (`validation_failed` on
 * `chzProductGroupCode`).
 */
export const productGroupRule = z.string().regex(/^(?:[1-9][0-9]*)?$/, "rules.productGroup");

/** A product group `productGroupRule` accepted, as the host takes it: `null` for none. */
export function toGroupCode(value: string): number | null {
  return value === "" ? null : Number(value);
}

```

3. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "badgeCode": "Код бейджа — от 1 до 256 символов: латинские буквы, цифры и знаки",
    "badgeCodeLayout": "Код набран русскими буквами — переключите раскладку на английскую"
  },
```

заменить на

<!-- prettier-ignore -->
```json
    "badgeCode": "Код бейджа — от 1 до 256 символов: латинские буквы, цифры и знаки",
    "badgeCodeLayout": "Код набран русскими буквами — переключите раскладку на английскую",
    "gtin": "GTIN — 8, 12, 13 или 14 цифр",
    "gtinCheckDigit": "Неверная контрольная цифра GTIN",
    "productName": "Укажите название товара, до 200 символов",
    "printName": "Название для печати — до 200 символов",
    "boxCapacity": "Укажите целое число от 1 до 100 000 или оставьте пустым",
    "palletBoxCapacity": "Укажите целое число от 1 до 10 000 или оставьте пустым",
    "shelfLifeDays": "Укажите целое число дней от 1 до 3650 или оставьте пустым",
    "productGroup": "Выберите группу из списка"
  },
```

4. Create `apps/standalone/src/lib/template-eligibility.ts`:

<!-- prettier-ignore -->
```ts
import {
  isBoxLabelTemplateEligible,
  isPalletLabelTemplateEligible,
  type LabelTemplatePurpose,
} from "@markiro/domain";

// Which template may stand in a slot (stage 1 spec §4.3): the host's
// `templates::fits`, written for the webview. The cases both must answer
// alike are in `proto/fixtures/template-eligibility.json`, which
// `host/tests/templates.rs` and `test/template-eligibility.test.ts` both read.

/** What decides whether a template fits a slot (the host's `templates::Scope`). */
export interface TemplateScope {
  purpose: LabelTemplatePurpose;
  enabled: boolean;
  /** `null` for every category, otherwise the ЧЗ product-group codes. */
  chzProductGroupCodes: readonly number[] | null;
}

/**
 * A slot a template may stand in: a purpose and a category. Category `null`
 * is the organization's slot, and the slot of a product without a group: only
 * a template for every category fits it.
 */
export interface TemplateSlot {
  purpose: LabelTemplatePurpose;
  chzProductGroupCode: number | null;
}

/**
 * Whether `template` fits `slot`: enabled, of the slot's purpose, and covering
 * its category. A box or a pallet slot asks `@markiro/domain`
 * (`isBoxLabelTemplateEligible`, `isPalletLabelTemplateEligible`). The domain
 * has no rule for a product duplicate, which the cloud never defaults, so the
 * duplicate slot is the same rule written out here.
 */
export function templateFitsSlot(template: TemplateScope, slot: TemplateSlot): boolean {
  switch (slot.purpose) {
    case "box":
      return isBoxLabelTemplateEligible(template, slot.chzProductGroupCode);
    case "pallet":
      return isPalletLabelTemplateEligible(template, slot.chzProductGroupCode);
    case "product_duplicate":
      return (
        template.enabled &&
        template.purpose === "product_duplicate" &&
        (template.chzProductGroupCodes === null ||
          (slot.chzProductGroupCode !== null &&
            template.chzProductGroupCodes.includes(slot.chzProductGroupCode)))
      );
  }
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/template-eligibility.test.ts`
Expected: PASS — 62 теста (46 и 16).

Run: то же с `--reporter=verbose` — stderr пуст; затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 62.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/lib/rules.ts` принять GTIN любой длины от 8 до 14: фрагмент

<!-- prettier-ignore -->
```ts
const GTIN_DIGITS = /^(?:[0-9]{8}|[0-9]{12,14})$/;
```

заменить на

<!-- prettier-ignore -->
```ts
const GTIN_DIGITS = /^[0-9]{8,14}$/;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "wrong length"`
Expected: FAIL — `460068200: expected 'rules.gtinCheckDigit' to be 'rules.gtin'`.

Мутация 2. В `apps/standalone/src/lib/rules.ts` не проверять контрольную цифру: фрагмент

<!-- prettier-ignore -->
```ts
  .regex(GTIN_DIGITS, "rules.gtin")
  .refine((gtin) => !GTIN_DIGITS.test(gtin) || isValidGtin(gtin), "rules.gtinCheckDigit");
```

заменить на

<!-- prettier-ignore -->
```ts
  .regex(GTIN_DIGITS, "rules.gtin");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "wrong check digit"`
Expected: FAIL — `4600682000010: expected undefined to be 'rules.gtinCheckDigit'`.

Мутация 3. В `apps/standalone/src/lib/rules.ts` принять ноль и ведущий ноль: фрагмент

<!-- prettier-ignore -->
```ts
const WHOLE_NUMBER = /^[1-9][0-9]*$/;
```

заменить на

<!-- prettier-ignore -->
```ts
const WHOLE_NUMBER = /^[0-9]+$/;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "takes a whole number"`
Expected: FAIL — 3 теста, первый: `0: expected undefined to be 'rules.boxCapacity'`.

Мутация 4. В `apps/standalone/src/lib/rules.ts` не принять сам потолок: фрагмент

<!-- prettier-ignore -->
```ts
    .refine((text) => text === "" || (WHOLE_NUMBER.test(text) && Number(text) <= max), message);
```

заменить на

<!-- prettier-ignore -->
```ts
    .refine((text) => text === "" || (WHOLE_NUMBER.test(text) && Number(text) < max), message);
```

Run: та же команда, что у мутации 3.
Expected: FAIL — 3 теста, первый: `100000: expected 'rules.boxCapacity' to be undefined`.

Мутация 5. В `apps/standalone/src/lib/rules.ts` другой потолок короба: фрагмент

<!-- prettier-ignore -->
```ts
export const MAX_BOX_CAPACITY = 100_000;
```

заменить на

<!-- prettier-ignore -->
```ts
export const MAX_BOX_CAPACITY = 100_001;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "host's caps"`
Expected: FAIL — `expected 100001 to be 100000`.

Мутация 6. В `apps/standalone/src/lib/template-eligibility.ts` пустить в слот дубликата выключенный шаблон: фрагмент

<!-- prettier-ignore -->
```ts
        template.enabled &&
        template.purpose === "product_duplicate" &&
```

заменить на

<!-- prettier-ignore -->
```ts
        template.purpose === "product_duplicate" &&
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-eligibility.test.ts`
Expected: FAIL — среди прочих `answers case 10 as the host does`: `expected true to be false`.

Мутация 7. В `apps/standalone/src/lib/template-eligibility.ts` не сверять назначение в слоте дубликата: фрагмент

<!-- prettier-ignore -->
```ts
        template.enabled &&
        template.purpose === "product_duplicate" &&
```

заменить на

<!-- prettier-ignore -->
```ts
        template.enabled &&
```

Run: та же команда, что у мутации 6.
Expected: FAIL — среди прочих `takes no template of another purpose, and puts a duplicate template in no other slot`.

Мутация 8. В `apps/standalone/src/lib/template-eligibility.ts` не сверять категории в слоте дубликата: фрагмент

<!-- prettier-ignore -->
```ts
            template.chzProductGroupCodes.includes(slot.chzProductGroupCode)))
```

заменить на

<!-- prettier-ignore -->
```ts
            true))
```

Run: та же команда, что у мутации 6.
Expected: FAIL — среди прочих `takes an enabled duplicate template that covers the category, and no other`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
1–10 000 boxes (`MAX_BOX_CAPACITY`, `MAX_PALLET_BOX_CAPACITY`: the cloud caps
neither, so these only keep a typing slip out of production), a shelf life
is 1–3650 days (the cloud's bound), and a product group must exist. The
default box and pallet templates are preferences: the host checks that each
```

заменить на

<!-- prettier-ignore -->
```text
1–10 000 boxes (`MAX_BOX_CAPACITY`, `MAX_PALLET_BOX_CAPACITY`: the cloud caps
neither, so these only keep a typing slip out of production), a shelf life
is 1–3650 days (the cloud's bound), and a product group must exist. The
office checks the same before it sends (`src/lib/rules.ts`, the limits as
constants of the same names): a GTIN of 8, 12, 13 or 14 ASCII digits with a
valid check digit (`gtinRule`; the domain throws one `GTIN_INVALID` for a
wrong length and a wrong check digit, so the rule checks the length itself
and says each in its own words), sent as its 14 digits (`toGtin14`), and
counts typed as text and taken only as whole numbers without a sign, a
leading zero, a point or an exponent (`countRule`), blank for none. The
default box and pallet templates are preferences: the host checks that each
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
The rule for a slot is `templates::fits`, the domain's
`isBoxLabelTemplateEligible` rewritten: `proto/fixtures/template-eligibility.json`
holds the cases the two rules must answer alike; only the host reads it
today (`host/tests/templates.rs`), and plan 1e2 adds the Vitest side.
```

заменить на

<!-- prettier-ignore -->
```text
The rule for a slot is `templates::fits`, the domain's
`isBoxLabelTemplateEligible` rewritten. The webview's `templateFitsSlot`
(`src/lib/template-eligibility.ts`) asks the domain for a box or a pallet
slot and checks a product duplicate, for which the domain has no rule, the
same way. `proto/fixtures/template-eligibility.json` holds the cases the
rules must answer alike, and `host/tests/templates.rs` and
`test/template-eligibility.test.ts` both read every one.
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
- правило слота — `template-eligibility.json`: случаи, на которые `templates::fits`
  хоста и правило `@markiro/domain` должны отвечать одинаково (сегодня фикстуру
  читает только хост, сторону Vitest добавит план 1e2).
```

заменить на

<!-- prettier-ignore -->
```text
- правило слота — `template-eligibility.json`: случаи, на которые `templates::fits`
  хоста и `templateFitsSlot` вебвью (правило `@markiro/domain` для короба и
  паллеты, то же правило для дубликата) должны отвечать одинаково; фикстуру
  читают и тест хоста, и Vitest (план 1e2).
```

Перечитать изменённые разделы целиком: «Catalog and label templates» в `AGENTS.md` и §4.5 спецификации (список фикстур) — правило слота нигде не названо «только хоста», а правила формы совпадают с `src/lib/rules.ts`.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/lib/rules.ts apps/standalone/src/lib/template-eligibility.ts apps/standalone/src/i18n/ru.json apps/standalone/test/rules.test.ts apps/standalone/test/template-eligibility.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 38 файлов, 841 тест (813 + 28).

```bash
git add apps/standalone/src/lib/rules.ts apps/standalone/src/lib/template-eligibility.ts apps/standalone/src/i18n/ru.json apps/standalone/test/rules.test.ts apps/standalone/test/template-eligibility.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): правила полей товара и правило слота шаблона в вебвью" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Слой протокола каталога — схемы ответов, тела запросов, методы `HostApi`, шаблоны мастера

Слой протокола всего каталога (D5): схемы ответов (`productGroupSchema`, `officeProductSchema`, `labelTemplateSummarySchema`, `labelTemplateSchema`, `templateDefaultsSchema` с `categoryTemplateDefaultSchema`), строгие схемы тел и по одному сборщику на тело (`productCreate`, `productUpdate`, `templateCreate`, `templateUpdate`, `templateDefaultsUpdate`), одиннадцать методов `HostApi` и их заглушки `unexpected()` в `fakeHostApi`, необязательные `templates` мастера. Шаблоны и умолчания позовут только экраны плана 1e3, поэтому каждый сборщик и метод проходит тест здесь: сборщик выдаёт фикстуру запроса плана 1e1 ровно (`toStrictEqual`), метод идёт по своему пути со своим телом и разбирает ответ фикстурой. После задачи 3 каждую фикстуру плана 1e1 читают и Rust, и Vitest (спецификация §6).

Ловушки, которые закрепляют тесты: размеры шаблона бывают дробными (`widthMm` 58.5), а `dpi` — только целым; `null` у `name`, `enabled` и `spec` в теле правки шаблона хост отвергает (это не «без изменений»), а `null` у категорий значит «все категории», поэтому сборщик не шлёт `null` в первых трёх никогда; категории правки — три состояния (нет поля, `null`, список), и тот же набор в другом порядке — изменение (хост хранит категории в присланном порядке); макет — непрозрачный объект: массив, строка, число, `null` и пустота отвергаются одной проблемой `custom`; у `orgDefault` и `templates` мастера отсутствие значит «нет», а `null` хост не принимает. Записи ленты (`productRecordSchema` и соседи) и три шаблона организации — задача 3: их проверяет синхронизация.

**Files:**

- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`
- Test: `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`
- Modify: `apps/standalone/AGENTS.md` («Protocol»)

**Interfaces:**

- Consumes:
  - `client.request(method, path, { body?, officeToken, schema })`, `NO_CONTENT` — `src/host/api.ts`; `errorBodySchema`, `bootstrapRequestSchema` — `src/host/protocol.ts`;
  - `fixture(name)`, `feedRecord(name, index)` — `test/protocol.test.ts`; таблица `CASES` и `recording(answer)` — `test/api.test.ts`; `unexpected(name)` — `test/support/office.tsx`.
- Produces (`src/host/protocol.ts`):
  - `templatePurposeSchema` (`box`, `pallet`, `product_duplicate`), `productStatusSchema` (`draft`, `active`), `templateSpecSchema` (`z.custom<Record<string, unknown>>`, простой объект);
  - `productGroupSchema` и `type ProductGroup { code, alias, name }`; `officeProductSchema` и `type OfficeProduct { id, gtin14, name, printName, chzProductGroupCode, boxCapacity, palletBoxCapacity, shelfLifeDays, defaultBoxTemplateId, defaultPalletTemplateId, archived, status, rev }`;
  - `labelTemplateSummarySchema` и `type LabelTemplateSummary { id, name, purpose, enabled, chzProductGroupCodes, stock, widthMm, heightMm, dpi, language, rev }`; `labelTemplateSchema` и `type LabelTemplate` (то же и `spec`);
  - `categoryTemplateDefaultSchema` и `type CategoryTemplateDefault { chzProductGroupCode, purpose, templateId }`; `templateDefaultsSchema` и `type TemplateDefaults { defaultBoxTemplateId, defaultPalletTemplateId, defaultDuplicateTemplateId, categories, rev }`;
  - строгие `productCreateSchema`, `productUpdateSchema`, `templateCreateSchema`, `templateUpdateSchema`, `templateDefaultsUpdateSchema` и их типы `ProductCreate`, `ProductUpdate`, `TemplateCreate`, `TemplateUpdate`, `TemplateDefaultsUpdate`; `stockTemplateSchema` и `bootstrapRequestSchema.templates` (необязательный).
- Produces (`src/host/requests.ts`):
  - `interface ProductInput { gtin14: string; name: string; printName: string | null; chzProductGroupCode: number | null; boxCapacity: number | null; palletBoxCapacity: number | null; shelfLifeDays: number | null; defaultBoxTemplateId: string | null; defaultPalletTemplateId: string | null }`;
  - `productCreate(product: ProductInput): ProductCreate`; `productUpdate(product: ProductInput, archived: boolean, expectedRev: number): ProductUpdate`;
  - `interface TemplateInput`, `templateCreate(template: TemplateInput): TemplateCreate`; `interface TemplateChange`, `templateUpdate(template: Pick<LabelTemplate, "name" | "enabled" | "chzProductGroupCodes" | "rev">, next: TemplateChange): TemplateUpdate`;
  - `interface TemplateDefaultsInput`, `templateDefaultsUpdate(defaults: TemplateDefaultsInput, expectedRev: number): TemplateDefaultsUpdate`.
- Produces (`HostApi`, `src/host/api.ts`; у каждого метода первый аргумент — `token: string`):
  - `listProductGroups` → `ProductGroup[]` (`GET /v1/office/product-groups`); `listProducts` → `OfficeProduct[]`; `createProduct(token, create: ProductCreate)`, `updateProduct(token, id, update: ProductUpdate)` → `OfficeProduct`;
  - `listTemplates` → `LabelTemplateSummary[]`; `getTemplate(token, id)`, `createTemplate(token, create)`, `updateTemplate(token, id, update)` → `LabelTemplate`; `deleteTemplate(token, id)` → `void` (204);
  - `getTemplateDefaults` → `TemplateDefaults`; `updateTemplateDefaults(token, update)` → `TemplateDefaults`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officeSessionSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officeProductSchema,
  officeSessionSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
```

2. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";
import {
  badgeCreate,
```

заменить на

<!-- prettier-ignore -->
```ts
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
  productCreateSchema,
  productGroupSchema,
  productUpdateSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
  stockTemplateSchema,
  templateCreateSchema,
  templateDefaultsSchema,
  templateDefaultsUpdateSchema,
  templateSpecSchema,
  templateUpdateSchema,
} from "../src/host/protocol.js";
import {
  badgeCreate,
```

3. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  operatorCreate,
  operatorUpdate,
  pairingCodeRequest,
} from "../src/host/requests.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
```

заменить на

<!-- prettier-ignore -->
```ts
  operatorCreate,
  operatorUpdate,
  pairingCodeRequest,
  productCreate,
  productUpdate,
  templateCreate,
  templateDefaultsUpdate,
  templateUpdate,
} from "../src/host/requests.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
```

4. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["office-line.json", officeLineSchema],
  ["office-operator.json", officeOperatorSchema],
  ["badge-salt.json", badgeSaltSchema],
] as const;

const REQUESTS = [
```

заменить на

<!-- prettier-ignore -->
```ts
  ["office-line.json", officeLineSchema],
  ["office-operator.json", officeOperatorSchema],
  ["badge-salt.json", badgeSaltSchema],
  ["product-group.json", productGroupSchema],
  ["office-product.json", officeProductSchema],
  ["template-summary.json", labelTemplateSummarySchema],
  ["label-template.json", labelTemplateSchema],
  ["template-defaults.json", templateDefaultsSchema],
  ["error-template-is-default.json", errorBodySchema],
] as const;

const REQUESTS = [
```

5. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["operator-create.json", operatorCreateSchema],
  ["operator-update.json", operatorUpdateSchema],
  ["badge-create.json", badgeCreateSchema],
] as const;

function extended(name: string): Record<string, unknown> {
```

заменить на

<!-- prettier-ignore -->
```ts
  ["operator-create.json", operatorCreateSchema],
  ["operator-update.json", operatorUpdateSchema],
  ["badge-create.json", badgeCreateSchema],
  ["product-create.json", productCreateSchema],
  ["product-update.json", productUpdateSchema],
  ["template-create.json", templateCreateSchema],
  ["template-update.json", templateUpdateSchema],
  ["template-defaults-update.json", templateDefaultsUpdateSchema],
  ["bootstrap-request-templates.json", bootstrapRequestSchema],
] as const;

function extended(name: string): Record<string, unknown> {
```

6. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    const scanned = { badgePhc, label: "Пропуск №7", code: "MRK-000742" };
    expect(badgeCreate(scanned)).toStrictEqual(fixture("badge-create.json"));
  });
});

describe("request builders send only what changes", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
    const scanned = { badgePhc, label: "Пропуск №7", code: "MRK-000742" };
    expect(badgeCreate(scanned)).toStrictEqual(fixture("badge-create.json"));
  });

  it("a product to create, and one to update that clears the print name and archives it", () => {
    // A form holds more than the builder names: the GTIN as typed must not go.
    const typed = {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л",
      printName: "Молоко 3,2%",
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: 40,
      shelfLifeDays: 10,
      defaultBoxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      defaultPalletTemplateId: null,
      gtin: "4600682000013",
    };
    expect(productCreate(typed)).toStrictEqual(fixture("product-create.json"));
    const product = officeProductSchema.parse(fixture("office-product.json"));
    expect(
      productUpdate({ ...product, printName: null, palletBoxCapacity: 48 }, true, product.rev),
    ).toStrictEqual(fixture("product-update.json"));
  });

  it("a template to create, and one to update that turns it off and adds a category", () => {
    const { spec } = templateCreateSchema.parse(fixture("template-create.json"));
    expect(
      templateCreate({
        name: "Молоко 58×40",
        purpose: "box",
        enabled: true,
        chzProductGroupCodes: null,
        spec,
      }),
    ).toStrictEqual(fixture("template-create.json"));
    const template = labelTemplateSchema.parse(fixture("label-template.json"));
    expect(
      templateUpdate(template, {
        name: template.name,
        enabled: false,
        chzProductGroupCodes: [8, 15],
      }),
    ).toStrictEqual(fixture("template-update.json"));
  });

  it("the template defaults, whole, over an older revision", () => {
    const defaults = templateDefaultsSchema.parse(fixture("template-defaults.json"));
    // The document's own `rev` is not sent: the builder names the fields it sends.
    expect(templateDefaultsUpdate(defaults, 63)).toStrictEqual(
      fixture("template-defaults-update.json"),
    );
  });
});

describe("request builders send only what changes", () => {
```

7. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(operatorUpdate(anna, { pinPhc })).toStrictEqual({ pinPhc, expectedRev: 55 });
  });

  it("copies the prefix list rather than handing over the caller's array", () => {
    const gs1Prefixes = ["4601234"];
    const body = counterpartyCreate({
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(operatorUpdate(anna, { pinPhc })).toStrictEqual({ pinPhc, expectedRev: 55 });
  });

  it("names only the template fields that differ, with three states for the categories", () => {
    const template = { name: "Молоко 58×40", enabled: true, chzProductGroupCodes: [8], rev: 62 };
    const everyCategory = { ...template, chzProductGroupCodes: null };
    // Left out: kept. The same list: no change.
    expect(templateUpdate(template, {})).toStrictEqual({ expectedRev: 62 });
    expect(
      templateUpdate(template, { name: "Молоко 58×40", enabled: true, chzProductGroupCodes: [8] }),
    ).toStrictEqual({ expectedRev: 62 });
    // `null`: every category; a list: those, in the order given.
    expect(templateUpdate(template, { chzProductGroupCodes: null })).toStrictEqual({
      chzProductGroupCodes: null,
      expectedRev: 62,
    });
    expect(templateUpdate(everyCategory, { chzProductGroupCodes: [15] })).toStrictEqual({
      chzProductGroupCodes: [15],
      expectedRev: 62,
    });
    expect(templateUpdate(everyCategory, { chzProductGroupCodes: null })).toStrictEqual({
      expectedRev: 62,
    });
    expect(
      templateUpdate(
        { ...template, chzProductGroupCodes: [8, 15] },
        { chzProductGroupCodes: [15, 8] },
      ),
    ).toStrictEqual({ chzProductGroupCodes: [15, 8], expectedRev: 62 });
    expect(templateUpdate(template, { name: "Молоко 58×40 (2)", enabled: false })).toStrictEqual({
      name: "Молоко 58×40 (2)",
      enabled: false,
      expectedRev: 62,
    });
    // A layout goes whenever it is given.
    const spec = { widthMm: 58, heightMm: 40 };
    expect(templateUpdate(template, { spec })).toStrictEqual({ spec, expectedRev: 62 });
  });

  it("copies the prefix list rather than handing over the caller's array", () => {
    const gs1Prefixes = ["4601234"];
    const body = counterpartyCreate({
```

8. В `apps/standalone/test/protocol.test.ts`, фрагмент

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

describe("catalog shapes", () => {
  it("read a template-is-default refusal with the defaults the change would break", () => {
    const body = errorBodySchema.parse(fixture("error-template-is-default.json"));
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({
      constraint: "template_is_default",
      organizationDefault: true,
      categoryDefaults: [8, 15],
    });
  });

  it("read a summary whose layout has no size, resolution or language, or a fractional size", () => {
    const summary = labelTemplateSummarySchema.parse(fixture("template-summary.json"));
    const bare = { ...summary, widthMm: null, heightMm: null, dpi: null, language: null };
    expect(labelTemplateSummarySchema.parse(bare)).toEqual(bare);
    const fractional = { ...summary, widthMm: 58.5, heightMm: 39.75 };
    expect(labelTemplateSummarySchema.parse(fractional)).toEqual(fractional);
    expect(labelTemplateSummarySchema.safeParse({ ...summary, dpi: 203.5 }).success).toBe(false);
  });

  it("read a layout as an opaque object: any keys, never an array, a scalar or nothing", () => {
    const layout = { "10": "ten", widthMm: 58, elements: [{ kind: "field", id: "name" }] };
    expect(templateSpecSchema.parse(layout)).toBe(layout);
    expect(templateSpecSchema.safeParse({}).success).toBe(true);
    for (const value of [[], "{}", 58, null, undefined]) {
      expect(templateSpecSchema.safeParse(value).error?.issues.map((issue) => issue.code)).toEqual([
        "custom",
      ]);
    }
  });

  it("refuse null where the host does not take it: a template's name, flag and layout, orgDefault, templates", () => {
    for (const field of ["name", "enabled", "spec"]) {
      expect(templateUpdateSchema.safeParse({ [field]: null, expectedRev: 62 }).success).toBe(
        false,
      );
    }
    expect(
      templateUpdateSchema.safeParse({ chzProductGroupCodes: null, expectedRev: 62 }).success,
    ).toBe(true);
    const request = bootstrapRequestSchema.parse(fixture("bootstrap-request-templates.json"));
    const [stock] = request.templates ?? [];
    expect(stockTemplateSchema.safeParse({ ...stock, orgDefault: null }).success).toBe(false);
    expect(bootstrapRequestSchema.safeParse({ ...request, templates: null }).success).toBe(false);
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
```

9. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  lineUpdateSchema,
  officeOperatorSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
} from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
```

заменить на

<!-- prettier-ignore -->
```ts
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  labelTemplateSchema,
  lineUpdateSchema,
  officeOperatorSchema,
  officeProductSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
  productCreateSchema,
  productUpdateSchema,
  templateCreateSchema,
  templateDefaultsUpdateSchema,
  templateUpdateSchema,
} from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
```

10. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
const OPERATOR_UPDATE = operatorUpdateSchema.parse(fixture("operator-update.json"));
const BADGE_CREATE = badgeCreateSchema.parse(fixture("badge-create.json"));
const BADGE_ID = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

type Case = [
  name: string,
```

заменить на

<!-- prettier-ignore -->
```ts
const OPERATOR_UPDATE = operatorUpdateSchema.parse(fixture("operator-update.json"));
const BADGE_CREATE = badgeCreateSchema.parse(fixture("badge-create.json"));
const BADGE_ID = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const PRODUCT = officeProductSchema.parse(fixture("office-product.json"));
const PRODUCT_CREATE = productCreateSchema.parse(fixture("product-create.json"));
const PRODUCT_UPDATE = productUpdateSchema.parse(fixture("product-update.json"));
const TEMPLATE = labelTemplateSchema.parse(fixture("label-template.json"));
const TEMPLATE_CREATE = templateCreateSchema.parse(fixture("template-create.json"));
const TEMPLATE_UPDATE = templateUpdateSchema.parse(fixture("template-update.json"));
const DEFAULTS_UPDATE = templateDefaultsUpdateSchema.parse(
  fixture("template-defaults-update.json"),
);

type Case = [
  name: string,
```

11. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    { method: "GET", path: "/v1/office/badge-salt", body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "GET", path: "/v1/office/badge-salt", body: undefined },
  ],
  [
    "listProductGroups",
    [fixture("product-group.json")],
    (api) => api.listProductGroups(TOKEN),
    { method: "GET", path: "/v1/office/product-groups", body: undefined },
  ],
  [
    "listProducts",
    [fixture("office-product.json")],
    (api) => api.listProducts(TOKEN),
    { method: "GET", path: "/v1/office/products", body: undefined },
  ],
  [
    "createProduct",
    fixture("office-product.json"),
    (api) => api.createProduct(TOKEN, PRODUCT_CREATE),
    { method: "POST", path: "/v1/office/products", body: PRODUCT_CREATE },
  ],
  [
    "updateProduct",
    fixture("office-product.json"),
    (api) => api.updateProduct(TOKEN, PRODUCT.id, PRODUCT_UPDATE),
    { method: "PUT", path: `/v1/office/products/${PRODUCT.id}`, body: PRODUCT_UPDATE },
  ],
  [
    "listTemplates",
    [fixture("template-summary.json")],
    (api) => api.listTemplates(TOKEN),
    { method: "GET", path: "/v1/office/templates", body: undefined },
  ],
  [
    "getTemplate",
    fixture("label-template.json"),
    (api) => api.getTemplate(TOKEN, TEMPLATE.id),
    { method: "GET", path: `/v1/office/templates/${TEMPLATE.id}`, body: undefined },
  ],
  [
    "createTemplate",
    fixture("label-template.json"),
    (api) => api.createTemplate(TOKEN, TEMPLATE_CREATE),
    { method: "POST", path: "/v1/office/templates", body: TEMPLATE_CREATE },
  ],
  [
    "updateTemplate",
    fixture("label-template.json"),
    (api) => api.updateTemplate(TOKEN, TEMPLATE.id, TEMPLATE_UPDATE),
    { method: "PUT", path: `/v1/office/templates/${TEMPLATE.id}`, body: TEMPLATE_UPDATE },
  ],
  [
    "deleteTemplate",
    null,
    (api) => api.deleteTemplate(TOKEN, TEMPLATE.id),
    { method: "DELETE", path: `/v1/office/templates/${TEMPLATE.id}`, body: undefined },
  ],
  [
    "getTemplateDefaults",
    fixture("template-defaults.json"),
    (api) => api.getTemplateDefaults(TOKEN),
    { method: "GET", path: "/v1/office/template-defaults", body: undefined },
  ],
  [
    "updateTemplateDefaults",
    fixture("template-defaults.json"),
    (api) => api.updateTemplateDefaults(TOKEN, DEFAULTS_UPDATE),
    { method: "PUT", path: "/v1/office/template-defaults", body: DEFAULTS_UPDATE },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

12. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    createBadge: vi.fn<HostApi["createBadge"]>(() => unexpected("createBadge")),
    revokeBadge: vi.fn<HostApi["revokeBadge"]>(() => unexpected("revokeBadge")),
    getBadgeSalt: vi.fn<HostApi["getBadgeSalt"]>(() => unexpected("getBadgeSalt")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    createBadge: vi.fn<HostApi["createBadge"]>(() => unexpected("createBadge")),
    revokeBadge: vi.fn<HostApi["revokeBadge"]>(() => unexpected("revokeBadge")),
    getBadgeSalt: vi.fn<HostApi["getBadgeSalt"]>(() => unexpected("getBadgeSalt")),
    listProductGroups: vi.fn<HostApi["listProductGroups"]>(() => unexpected("listProductGroups")),
    listProducts: vi.fn<HostApi["listProducts"]>(() => unexpected("listProducts")),
    createProduct: vi.fn<HostApi["createProduct"]>(() => unexpected("createProduct")),
    updateProduct: vi.fn<HostApi["updateProduct"]>(() => unexpected("updateProduct")),
    listTemplates: vi.fn<HostApi["listTemplates"]>(() => unexpected("listTemplates")),
    getTemplate: vi.fn<HostApi["getTemplate"]>(() => unexpected("getTemplate")),
    createTemplate: vi.fn<HostApi["createTemplate"]>(() => unexpected("createTemplate")),
    updateTemplate: vi.fn<HostApi["updateTemplate"]>(() => unexpected("updateTemplate")),
    deleteTemplate: vi.fn<HostApi["deleteTemplate"]>(() => unexpected("deleteTemplate")),
    getTemplateDefaults: vi.fn<HostApi["getTemplateDefaults"]>(() =>
      unexpected("getTemplateDefaults"),
    ),
    updateTemplateDefaults: vi.fn<HostApi["updateTemplateDefaults"]>(() =>
      unexpected("updateTemplateDefaults"),
    ),
    ...overrides,
  };
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
Expected: FAIL — `test/api.test.ts` не загружается: `TypeError: Cannot read properties of undefined (reading 'parse')` (`officeProductSchema.parse` на уровне модуля); в `test/protocol.test.ts` 28 из 170 тестов падают: схем и сборщиков ещё нет (`Cannot read properties of undefined (reading 'parse')`, `productCreate is not a function`, `templateUpdate is not a function`), а тело мастера с `templates` отвергает строгая схема (`ZodError`, `unrecognized_keys`). Из 32 новых тестов четыре уже проходят: отказ `template_is_default` разбирает прежний `errorBodySchema` (три теста), а лишнее поле в теле мастера прежняя строгая схема и так отвергает.

- [ ] **Step 3: Схемы, сборщики и методы**

1. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export type OfficeRole = z.infer<typeof officeRoleSchema>;

/** Mirrors `markiro_proto::credentials`: which credential `unauthorized` rejected. */
export const credentialSchema = z.enum(["device", "session", "password"]);
export type Credential = z.infer<typeof credentialSchema>;

// --- The Rust shell's own payloads (strict) ---

/** `device_status` / `host_local_pair`: the pairing, never the device key. */
export const deviceStatusSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
export type OfficeRole = z.infer<typeof officeRoleSchema>;

/** Mirrors `markiro_proto::credentials`: which credential `unauthorized` rejected. */
export const credentialSchema = z.enum(["device", "session", "password"]);
export type Credential = z.infer<typeof credentialSchema>;

/** Mirrors `markiro_proto::TemplatePurpose`: what a label template prints. */
export const templatePurposeSchema = z.enum(["box", "pallet", "product_duplicate"]);
export type TemplatePurpose = z.infer<typeof templatePurposeSchema>;

/**
 * Mirrors `markiro_proto::ProductStatus`: `active` once a product has a group
 * and both capacities, `draft` before. The host computes it; nobody sends it.
 */
export const productStatusSchema = z.enum(["draft", "active"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/** A ЧЗ product group's code (a `u32` in `proto`). */
const groupCodeSchema = z.number().int().nonnegative();

/** A template's categories: `null` for every category, otherwise the group codes. */
const groupCodesSchema = z.array(groupCodeSchema).nullable();

/** A count a product may leave empty: units in a box, boxes on a pallet, days (a `u32` in `proto`). */
const countSchema = z.number().int().nonnegative().nullable();

/**
 * A label layout as the host keeps it: a JSON object, read as an opaque
 * value. Its own contract (the domain's `labelTemplateSpecSchema`) is checked
 * where a layout is used — by the template editor before it saves (plan 1e3)
 * and by the station before it prints (plan 2a) — never at sync time. A
 * dynamic-key `z.record` would put keys taken from the data into a quarantine
 * reason's paths (`AGENTS.md`, "Reference sync"); this check gives one
 * `custom` issue.
 */
export const templateSpecSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

// --- The Rust shell's own payloads (strict) ---

/** `device_status` / `host_local_pair`: the pairing, never the device key. */
export const deviceStatusSchema = z
```

2. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export const badgeSaltSchema = z.object({ badgeSalt: canonicalSaltSchema });
export type BadgeSalt = z.infer<typeof badgeSaltSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
export const badgeSaltSchema = z.object({ badgeSalt: canonicalSaltSchema });
export type BadgeSalt = z.infer<typeof badgeSaltSchema>;

/**
 * `GET /v1/office/product-groups`: a ЧЗ product group, the cloud's static
 * lookup. The host answers a bare list by code, not the cloud's `{ items }`.
 */
export const productGroupSchema = z.object({
  code: groupCodeSchema,
  alias: z.string(),
  name: z.string(),
});
export type ProductGroup = z.infer<typeof productGroupSchema>;

/**
 * `GET /v1/office/products`: a product as the office sees it, archived ones
 * included. `gtin14` is the 14 digits the office saved; the two templates are
 * preferences, which the host checks only for their purpose.
 */
export const officeProductSchema = z.object({
  id: z.uuid(),
  gtin14: z.string(),
  name: z.string(),
  printName: z.string().nullable(),
  chzProductGroupCode: groupCodeSchema.nullable(),
  boxCapacity: countSchema,
  palletBoxCapacity: countSchema,
  shelfLifeDays: countSchema,
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullable(),
  archived: z.boolean(),
  status: productStatusSchema,
  rev: z.number().int(),
});
export type OfficeProduct = z.infer<typeof officeProductSchema>;

/**
 * `GET /v1/office/templates`: a label template without its layout. The size,
 * the resolution and the language come from the stored layout as they stand:
 * `null` where it has nothing of the right type, and a size may be fractional.
 */
export const labelTemplateSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  purpose: templatePurposeSchema,
  enabled: z.boolean(),
  chzProductGroupCodes: groupCodesSchema,
  stock: z.boolean(),
  widthMm: z.number().nullable(),
  heightMm: z.number().nullable(),
  dpi: z.number().int().nonnegative().nullable(),
  language: z.string().nullable(),
  rev: z.number().int(),
});
export type LabelTemplateSummary = z.infer<typeof labelTemplateSummarySchema>;

/** `GET /v1/office/templates/{id}`, and the answer of `POST` and `PUT`: a template with its layout. */
export const labelTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  purpose: templatePurposeSchema,
  enabled: z.boolean(),
  chzProductGroupCodes: groupCodesSchema,
  stock: z.boolean(),
  spec: templateSpecSchema,
  rev: z.number().int(),
});
export type LabelTemplate = z.infer<typeof labelTemplateSchema>;

/**
 * A category's default template of one purpose: an entry of the template
 * defaults, and `data` of a `category_template_defaults` feed item, whose id
 * is `<code>:<purpose>` (`markiro_proto::CategoryTemplateDefault` is both).
 */
export const categoryTemplateDefaultSchema = z.object({
  chzProductGroupCode: groupCodeSchema,
  purpose: templatePurposeSchema,
  templateId: z.uuid(),
});
export type CategoryTemplateDefault = z.infer<typeof categoryTemplateDefaultSchema>;

/**
 * `GET /v1/office/template-defaults`: the organization's default of each
 * purpose and every category's, by code then purpose, as one document with its
 * revision.
 */
export const templateDefaultsSchema = z.object({
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullable(),
  defaultDuplicateTemplateId: z.uuid().nullable(),
  categories: z.array(categoryTemplateDefaultSchema),
  rev: z.number().int(),
});
export type TemplateDefaults = z.infer<typeof templateDefaultsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

3. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  .strict();
export type SsccStart = z.infer<typeof ssccStartSchema>;

export const bootstrapRequestSchema = z
  .object({
    admin: newOfficeUserSchema,
    org: orgProfileInputSchema,
    sscc: ssccStartSchema,
    lines: z.array(z.string()),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
  .strict();
export type SsccStart = z.infer<typeof ssccStartSchema>;

/**
 * A stock label template of the wizard (plan 1e3 sends them): stored enabled,
 * for every category, and kept as it came. `orgDefault: true` makes it the
 * organization's default of its purpose; left out it is `false`, and the host
 * refuses `null` there.
 */
export const stockTemplateSchema = z
  .object({
    name: z.string(),
    purpose: templatePurposeSchema,
    spec: templateSpecSchema,
    orgDefault: z.boolean().optional(),
  })
  .strict();
export type StockTemplate = z.infer<typeof stockTemplateSchema>;

/** `templates` may be left out (a wizard before plan 1e3), never `null`. */
export const bootstrapRequestSchema = z
  .object({
    admin: newOfficeUserSchema,
    org: orgProfileInputSchema,
    sscc: ssccStartSchema,
    lines: z.array(z.string()),
    templates: z.array(stockTemplateSchema).optional(),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;
```

4. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  .strict();
export type BadgeCreate = z.infer<typeof badgeCreateSchema>;

```

заменить на

<!-- prettier-ignore -->
```ts
  .strict();
export type BadgeCreate = z.infer<typeof badgeCreateSchema>;

/**
 * `POST /v1/office/products`: the GTIN as its 14 digits; the office sends
 * every field, `null` for one left blank.
 */
export const productCreateSchema = z
  .object({
    gtin14: z.string(),
    name: z.string(),
    printName: z.string().nullable(),
    chzProductGroupCode: groupCodeSchema.nullable(),
    boxCapacity: countSchema,
    palletBoxCapacity: countSchema,
    shelfLifeDays: countSchema,
    defaultBoxTemplateId: z.uuid().nullable(),
    defaultPalletTemplateId: z.uuid().nullable(),
  })
  .strict();
export type ProductCreate = z.infer<typeof productCreateSchema>;

/**
 * `PUT /v1/office/products/{id}`: the whole record with `archived` and the
 * loaded revision, as a counterparty's; `null` clears a field.
 */
export const productUpdateSchema = z
  .object({
    gtin14: z.string(),
    name: z.string(),
    printName: z.string().nullable(),
    chzProductGroupCode: groupCodeSchema.nullable(),
    boxCapacity: countSchema,
    palletBoxCapacity: countSchema,
    shelfLifeDays: countSchema,
    defaultBoxTemplateId: z.uuid().nullable(),
    defaultPalletTemplateId: z.uuid().nullable(),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type ProductUpdate = z.infer<typeof productUpdateSchema>;

/** `POST /v1/office/templates`: a template of the office's own; `chzProductGroupCodes: null` for every category. */
export const templateCreateSchema = z
  .object({
    name: z.string(),
    purpose: templatePurposeSchema,
    enabled: z.boolean(),
    chzProductGroupCodes: groupCodesSchema,
    spec: templateSpecSchema,
  })
  .strict();
export type TemplateCreate = z.infer<typeof templateCreateSchema>;

/**
 * `PUT /v1/office/templates/{id}`: only the fields sent change. Categories
 * have three states: left out keeps them, `null` widens the template to every
 * category, a list narrows it to those. `name`, `enabled` and `spec` are left
 * out or a value, never `null`: the host would read `null` there as «keep»,
 * which only leaving the field out says here. A purpose never changes, so it
 * is no field.
 */
export const templateUpdateSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    chzProductGroupCodes: groupCodesSchema.optional(),
    spec: templateSpecSchema.optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;

/** A category default in `PUT /v1/office/template-defaults`. */
export const categoryTemplateDefaultInputSchema = z
  .object({
    chzProductGroupCode: groupCodeSchema,
    purpose: templatePurposeSchema,
    templateId: z.uuid(),
  })
  .strict();

/**
 * `PUT /v1/office/template-defaults`: the whole document over the loaded
 * revision. An organization default `null` is none; a category default left
 * out of `categories` is cleared.
 */
export const templateDefaultsUpdateSchema = z
  .object({
    defaultBoxTemplateId: z.uuid().nullable(),
    defaultPalletTemplateId: z.uuid().nullable(),
    defaultDuplicateTemplateId: z.uuid().nullable(),
    categories: z.array(categoryTemplateDefaultInputSchema),
    expectedRev: z.number().int(),
  })
  .strict();
export type TemplateDefaultsUpdate = z.infer<typeof templateDefaultsUpdateSchema>;

```

5. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type {
  BadgeCreate,
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
  DeviceUpdate,
  LineCreate,
  LineUpdate,
  OfficeLine,
  OfficeOperator,
  OperatorCreate,
  OperatorUpdate,
  PairingCodeRequest,
} from "./protocol.js";

// The office's request bodies, each built field by field and never spread
```

заменить на

<!-- prettier-ignore -->
```ts
import type {
  BadgeCreate,
  CategoryTemplateDefault,
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
  DeviceUpdate,
  LabelTemplate,
  LineCreate,
  LineUpdate,
  OfficeLine,
  OfficeOperator,
  OperatorCreate,
  OperatorUpdate,
  PairingCodeRequest,
  ProductCreate,
  ProductUpdate,
  TemplateCreate,
  TemplateDefaultsUpdate,
  TemplatePurpose,
  TemplateSpec,
  TemplateUpdate,
} from "./protocol.js";

// The office's request bodies, each built field by field and never spread
```

6. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return { badgePhc: badge.badgePhc, label: badge.label };
}

```

заменить на

<!-- prettier-ignore -->
```ts
  return { badgePhc: badge.badgePhc, label: badge.label };
}

/**
 * A product's fields: the trimmed values the form accepted, the GTIN as its
 * 14 digits (`toGtin14`), `null` for a field left blank.
 */
export interface ProductInput {
  gtin14: string;
  name: string;
  printName: string | null;
  chzProductGroupCode: number | null;
  boxCapacity: number | null;
  palletBoxCapacity: number | null;
  shelfLifeDays: number | null;
  defaultBoxTemplateId: string | null;
  defaultPalletTemplateId: string | null;
}

/** `POST /v1/office/products` (`product-create.json`): every field, `null` for none. */
export function productCreate(product: ProductInput): ProductCreate {
  return {
    gtin14: product.gtin14,
    name: product.name,
    printName: product.printName,
    chzProductGroupCode: product.chzProductGroupCode,
    boxCapacity: product.boxCapacity,
    palletBoxCapacity: product.palletBoxCapacity,
    shelfLifeDays: product.shelfLifeDays,
    defaultBoxTemplateId: product.defaultBoxTemplateId,
    defaultPalletTemplateId: product.defaultPalletTemplateId,
  };
}

/**
 * `PUT /v1/office/products/{id}` (`product-update.json`): the whole record
 * with `archived` and the loaded revision; `null` clears a field.
 */
export function productUpdate(
  product: ProductInput,
  archived: boolean,
  expectedRev: number,
): ProductUpdate {
  return {
    gtin14: product.gtin14,
    name: product.name,
    printName: product.printName,
    chzProductGroupCode: product.chzProductGroupCode,
    boxCapacity: product.boxCapacity,
    palletBoxCapacity: product.palletBoxCapacity,
    shelfLifeDays: product.shelfLifeDays,
    defaultBoxTemplateId: product.defaultBoxTemplateId,
    defaultPalletTemplateId: product.defaultPalletTemplateId,
    archived,
    expectedRev,
  };
}

/**
 * A new template: the trimmed name, the purpose, the categories (`null` for
 * every category) and the layout the editor checked.
 */
export interface TemplateInput {
  name: string;
  purpose: TemplatePurpose;
  enabled: boolean;
  chzProductGroupCodes: readonly number[] | null;
  spec: TemplateSpec;
}

/** `POST /v1/office/templates` (`template-create.json`). */
export function templateCreate(template: TemplateInput): TemplateCreate {
  return {
    name: template.name,
    purpose: template.purpose,
    enabled: template.enabled,
    chzProductGroupCodes:
      template.chzProductGroupCodes === null ? null : [...template.chzProductGroupCodes],
    spec: template.spec,
  };
}

/**
 * What a template is to become; a field left out stays as it is. `null`
 * categories widen the template to every category; no other field takes
 * `null`.
 */
export interface TemplateChange {
  name?: string;
  enabled?: boolean;
  chzProductGroupCodes?: readonly number[] | null;
  spec?: TemplateSpec;
}

/** Whether two category lists are the same, in the same order (`null` is every category). */
function sameCodes(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

/**
 * `PUT /v1/office/templates/{id}` (`template-update.json`): the name, the
 * enabled flag and the categories that differ from the loaded template, with
 * its revision. Categories go in the order given, so a reordered list is a
 * change. A layout goes whenever one is given: comparing layouts of up to
 * 256 KB is the host's work, and an unchanged one writes nothing there.
 */
export function templateUpdate(
  template: Pick<LabelTemplate, "name" | "enabled" | "chzProductGroupCodes" | "rev">,
  next: TemplateChange,
): TemplateUpdate {
  const update: TemplateUpdate = { expectedRev: template.rev };
  if (next.name !== undefined && next.name !== template.name) update.name = next.name;
  if (next.enabled !== undefined && next.enabled !== template.enabled) {
    update.enabled = next.enabled;
  }
  if (
    next.chzProductGroupCodes !== undefined &&
    !sameCodes(next.chzProductGroupCodes, template.chzProductGroupCodes)
  ) {
    update.chzProductGroupCodes =
      next.chzProductGroupCodes === null ? null : [...next.chzProductGroupCodes];
  }
  if (next.spec !== undefined) update.spec = next.spec;
  return update;
}

/** The template defaults as they are to become: each organization default (`null` for none) and every category default. */
export interface TemplateDefaultsInput {
  defaultBoxTemplateId: string | null;
  defaultPalletTemplateId: string | null;
  defaultDuplicateTemplateId: string | null;
  categories: readonly CategoryTemplateDefault[];
}

/**
 * `PUT /v1/office/template-defaults` (`template-defaults-update.json`): the
 * whole document with the loaded revision; a category default left out is
 * cleared.
 */
export function templateDefaultsUpdate(
  defaults: TemplateDefaultsInput,
  expectedRev: number,
): TemplateDefaultsUpdate {
  return {
    defaultBoxTemplateId: defaults.defaultBoxTemplateId,
    defaultPalletTemplateId: defaults.defaultPalletTemplateId,
    defaultDuplicateTemplateId: defaults.defaultDuplicateTemplateId,
    categories: defaults.categories.map((entry) => ({
      chzProductGroupCode: entry.chzProductGroupCode,
      purpose: entry.purpose,
      templateId: entry.templateId,
    })),
    expectedRev,
  };
}

```

7. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  changesResponseSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  officeLineSchema,
  officeOperatorSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgProfileSchema,
  pairingCodeSchema,
  ssccCounterSchema,
  ssccStateSchema,
  type BadgeCreate,
  type BadgeInfo,
  type BadgeSalt,
```

заменить на

<!-- prettier-ignore -->
```ts
  changesResponseSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  officeLineSchema,
  officeOperatorSchema,
  officeProductSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgProfileSchema,
  pairingCodeSchema,
  productGroupSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
  type BadgeCreate,
  type BadgeInfo,
  type BadgeSalt,
```

8. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceUpdate,
  type LineCreate,
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeOperator,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
```

заменить на

<!-- prettier-ignore -->
```ts
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceUpdate,
  type LabelTemplate,
  type LabelTemplateSummary,
  type LineCreate,
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeOperator,
  type OfficeProduct,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
```

9. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type PairingCodeRequest,
  type PasswordChange,
  type PasswordSet,
  type SsccCounter,
  type SsccCounterUpdate,
  type SsccState,
} from "./protocol.js";

/** An SSCC counter's address: its issuer prefix and extension digit (0 box, 1 pallet). */
```

заменить на

<!-- prettier-ignore -->
```ts
  type PairingCodeRequest,
  type PasswordChange,
  type PasswordSet,
  type ProductCreate,
  type ProductGroup,
  type ProductUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
  type SsccState,
  type TemplateCreate,
  type TemplateDefaults,
  type TemplateDefaultsUpdate,
  type TemplateUpdate,
} from "./protocol.js";

/** An SSCC counter's address: its issuer prefix and extension digit (0 box, 1 pallet). */
```

10. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  revokeBadge: (token: string, operatorId: string, badgeId: string) => Promise<void>;
  /** The site's badge salt; `not_found` before the wizard created it. */
  getBadgeSalt: (token: string) => Promise<BadgeSalt>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  revokeBadge: (token: string, operatorId: string, badgeId: string) => Promise<void>;
  /** The site's badge salt; `not_found` before the wizard created it. */
  getBadgeSalt: (token: string) => Promise<BadgeSalt>;
  /** The ЧЗ product groups, by code: a static lookup. */
  listProductGroups: (token: string) => Promise<ProductGroup[]>;
  /** Every product, archived ones included. */
  listProducts: (token: string) => Promise<OfficeProduct[]>;
  createProduct: (token: string, create: ProductCreate) => Promise<OfficeProduct>;
  updateProduct: (token: string, id: string, update: ProductUpdate) => Promise<OfficeProduct>;
  /** Every template, without its layout. */
  listTemplates: (token: string) => Promise<LabelTemplateSummary[]>;
  /** One template with its layout. */
  getTemplate: (token: string, id: string) => Promise<LabelTemplate>;
  createTemplate: (token: string, create: TemplateCreate) => Promise<LabelTemplate>;
  updateTemplate: (token: string, id: string, update: TemplateUpdate) => Promise<LabelTemplate>;
  /** `204`; deleting it again after a lost answer answers `204` too. */
  deleteTemplate: (token: string, id: string) => Promise<void>;
  getTemplateDefaults: (token: string) => Promise<TemplateDefaults>;
  updateTemplateDefaults: (
    token: string,
    update: TemplateDefaultsUpdate,
  ) => Promise<TemplateDefaults>;
}

/** A 204 answer parses as `null`. */
```

11. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: badgeSaltSchema,
      }),
  };
}

```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: badgeSaltSchema,
      }),
    listProductGroups: (token) =>
      client.request("GET", "/v1/office/product-groups", {
        officeToken: token,
        schema: z.array(productGroupSchema),
      }),
    listProducts: (token) =>
      client.request("GET", "/v1/office/products", {
        officeToken: token,
        schema: z.array(officeProductSchema),
      }),
    createProduct: (token, create) =>
      client.request("POST", "/v1/office/products", {
        body: create,
        officeToken: token,
        schema: officeProductSchema,
      }),
    updateProduct: (token, id, update) =>
      client.request("PUT", `/v1/office/products/${id}`, {
        body: update,
        officeToken: token,
        schema: officeProductSchema,
      }),
    listTemplates: (token) =>
      client.request("GET", "/v1/office/templates", {
        officeToken: token,
        schema: z.array(labelTemplateSummarySchema),
      }),
    getTemplate: (token, id) =>
      client.request("GET", `/v1/office/templates/${id}`, {
        officeToken: token,
        schema: labelTemplateSchema,
      }),
    createTemplate: (token, create) =>
      client.request("POST", "/v1/office/templates", {
        body: create,
        officeToken: token,
        schema: labelTemplateSchema,
      }),
    updateTemplate: (token, id, update) =>
      client.request("PUT", `/v1/office/templates/${id}`, {
        body: update,
        officeToken: token,
        schema: labelTemplateSchema,
      }),
    deleteTemplate: async (token, id) => {
      await client.request("DELETE", `/v1/office/templates/${id}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getTemplateDefaults: (token) =>
      client.request("GET", "/v1/office/template-defaults", {
        officeToken: token,
        schema: templateDefaultsSchema,
      }),
    updateTemplateDefaults: (token, update) =>
      client.request("PUT", "/v1/office/template-defaults", {
        body: update,
        officeToken: token,
        schema: templateDefaultsSchema,
      }),
  };
}

```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
Expected: PASS — 211 тестов (170 и 41).

Run: то же с `--reporter=verbose` — stderr пуст; затем те же файлы под стендом с задержкой `setImmediate` — PASS, 211.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/host/requests.ts` слать категории правки шаблона всякий раз: фрагмент

<!-- prettier-ignore -->
```ts
  if (
    next.chzProductGroupCodes !== undefined &&
    !sameCodes(next.chzProductGroupCodes, template.chzProductGroupCodes)
  ) {
```

заменить на

<!-- prettier-ignore -->
```ts
  if (next.chzProductGroupCodes !== undefined) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "three states"`
Expected: FAIL — `expected { expectedRev: 62, …(1) } to strictly equal { expectedRev: 62 }`.

Мутация 2. В `apps/standalone/src/host/requests.ts` сравнивать категории без порядка: фрагмент

<!-- prettier-ignore -->
```ts
  return a.length === b.length && a.every((code, index) => code === b[index]);
```

заменить на

<!-- prettier-ignore -->
```ts
  return a.length === b.length && a.every((code) => b.includes(code));
```

Run: та же команда, что у мутации 1.
Expected: FAIL — `expected { expectedRev: 62 } to strictly equal { …(2) }`.

Мутация 3. В `apps/standalone/src/host/protocol.ts` принять массив за макет: фрагмент

<!-- prettier-ignore -->
```ts
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
```

заменить на

<!-- prettier-ignore -->
```ts
  (value) => typeof value === "object" && value !== null,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "opaque object"`
Expected: FAIL — `expected undefined to deeply equal [ 'custom' ]`.

Мутация 4. В `apps/standalone/src/host/protocol.ts` принять `null` в `orgDefault` шаблона мастера: фрагмент

<!-- prettier-ignore -->
```ts
    orgDefault: z.boolean().optional(),
```

заменить на

<!-- prettier-ignore -->
```ts
    orgDefault: z.boolean().nullish(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "refuse null"`
Expected: FAIL — `expected true to be false`.

Мутация 5. В `apps/standalone/src/host/requests.ts` собрать тело нового товара разворотом: фрагмент

<!-- prettier-ignore -->
```ts
export function productCreate(product: ProductInput): ProductCreate {
  return {
    gtin14: product.gtin14,
    name: product.name,
    printName: product.printName,
    chzProductGroupCode: product.chzProductGroupCode,
    boxCapacity: product.boxCapacity,
    palletBoxCapacity: product.palletBoxCapacity,
    shelfLifeDays: product.shelfLifeDays,
    defaultBoxTemplateId: product.defaultBoxTemplateId,
    defaultPalletTemplateId: product.defaultPalletTemplateId,
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
export function productCreate(product: ProductInput): ProductCreate {
  return { ...product };
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "a product to create"`
Expected: FAIL — `expected { gtin14: '04600682000013', …(9) } to strictly equal { gtin14: '04600682000013', …(8) }`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
`src/host/requests.ts`, which names every field it sends;
`test/protocol.test.ts` checks that each builder produces its fixture exactly.
The older forms (users, the organization, SSCC, sign-in and the own-password
change) build their bodies inline, field by field, as does the wizard. Raise
```

заменить на

<!-- prettier-ignore -->
```text
`src/host/requests.ts`, which names every field it sends;
`test/protocol.test.ts` checks that each builder produces its fixture exactly.
The catalog's builders (plan 1e2) cover the template routes too, which only
plan 1e3's screens will call: `productCreate` and `productUpdate` send every
field, `null` for a blank one; `templateUpdate` sends the name, the flag and
the categories that differ from the loaded template and a layout whenever
one is given, its categories in three states (left out keeps them, `null` is
every category, a list is those, and a reordered list is a change), and
never `null` for a name, a flag or a layout, which the host would read as
«keep»; `templateDefaultsUpdate` sends the whole document.
The older forms (users, the organization, SSCC, sign-in and the own-password
change) build their bodies inline, field by field, as does the wizard; its
optional `templates`, which plan 1e3 sends, are typed by the strict
`bootstrapRequestSchema`, which reads `bootstrap-request-templates.json`. Raise
```

Перечитать раздел «Protocol» в `AGENTS.md` целиком: список сборщиков полон, а схемы записей ленты каталога названы там, где их вводит задача 3.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx apps/standalone/AGENTS.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 38 файлов, 884 теста (841 + 43).

```bash
git add apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx apps/standalone/AGENTS.md
git commit -m "feat(standalone): слой протокола каталога — схемы, сборщики тел, методы HostApi, шаблоны мастера" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Копии каталога на станции — миграция 0004, записи ленты, синхронизация, `SYNC_SCHEMA_VERSION` 4

Станция получает копии товаров, шаблонов и умолчаний категорий и три шаблона организации. Миграция оболочки `0004_catalog.sql` добавляет таблицы `ref_products`, `ref_templates`, `ref_template_defaults` и три столбца `ref_org` — без внешних ключей, без `UNIQUE` и без `CHECK`: нарушение сорвало бы всю порцию и остановило синхронизацию навсегда (надгробие удалённого шаблона приходит в той же ревизии раньше товаров, у которых снята ссылка; шаблон может ждать в карантине; у архивного товара тот же GTIN, что у товара в работе). Индекс один — `ref_products(gtin14)`: по нему план 2a найдёт отсканированный товар.

Записи ленты каталога читаются нестрого (D1): `productRecordSchema` и `labelTemplateRecordSchema` — `z.object`, умолчание категории — та же `categoryTemplateDefaultSchema`, что в документе умолчаний (задача 2); незнакомый ключ отбрасывается, а значение, которое станция не прочтёт (GTIN не из 14 цифр, неизвестные назначение или статус, идентификатор шаблона не UUID, макет не объект), уводит запись в карантин с точной причиной. У записи организации три шаблона — `z.uuid().nullish()`: хост до плана 1e1 их не шлёт, и обязательное поле увело бы в карантин всю запись. Каждый upsert каталога несёт защиту `notQuarantinedNewer` (D4), копии хранят признаки и ничего не отбирают (D6), `SYNC_SCHEMA_VERSION` — 4 (D7): восемь сущностей, худшая порция — 30 операторов из 32.

Ревизия больше 1 МиБ (шаблоны мастера, удаление шаблона, снявшее ссылку у тысяч товаров) приходит целиком: по одному параметру JSON на сущность. Ограничения оболочки считают текст SQL и число значений, а не размер значения; это закрепляет новый тест Rust. Текст `spec` в копии — то, что даёт `JSON.stringify` разобранного макета (ключи-целые числа — первыми), не байты хоста.

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0004_catalog.sql`
- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/local/reference-sync.ts`
- Test: `apps/standalone/test/reference-sync.test.ts`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/local-executor.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`
- Modify: `apps/standalone/AGENTS.md` («Change feed», «Local database», «Reference sync»), спецификация §4.4, §4.5, §5.3, §5.4, §6

**Interfaces:**

- Consumes:
  - `templatePurposeSchema`, `productStatusSchema`, `templateSpecSchema`, `categoryTemplateDefaultSchema` (задача 2), `orgRecordSchema`, `changesResponseSchema`, `type ChangeItem` — `src/host/protocol.ts`;
  - `ENTITIES`, `checked(schema, item)`, `notQuarantinedNewer(entity)`, `pageStatements`, `syncReferences({ changes, local, hostId, now })` — `src/local/reference-sync.ts`;
  - `openLocalDb()` — `test/support/local-db.ts`; `page`, `feed`, `quarantine`, `COPY_TABLES` — `test/reference-sync.test.ts`; `open()`, `statement(sql, values)` — `src-tauri/tests/local_db.rs`.
- Produces:
  - `productRecordSchema` и `type ProductRecord { gtin14, name, printName, chzProductGroupCode, boxCapacity, palletBoxCapacity, shelfLifeDays, defaultBoxTemplateId, defaultPalletTemplateId, archived, status }`; `labelTemplateRecordSchema` и `type LabelTemplateRecord { name, purpose, enabled, chzProductGroupCodes, stock, spec }`;
  - `orgRecordSchema` с `defaultBoxTemplateId`, `defaultPalletTemplateId`, `defaultDuplicateTemplateId` (`z.uuid().nullish()`);
  - сущности синхронизации `products` → `ref_products`, `label_templates` → `ref_templates`, `category_template_defaults` → `ref_template_defaults`; `ENTITY_SET` = `org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults;v4`;
  - таблицы `ref_products`, `ref_templates`, `ref_template_defaults`, индекс `ref_products_gtin14`, столбцы `ref_org.default_box_template_id`, `default_pallet_template_id`, `default_duplicate_template_id`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  changesResponseSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../src/host/protocol.js";
import { hashPin } from "../src/lib/credentials.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  changesResponseSchema,
  labelTemplateRecordSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../src/host/protocol.js";
import { hashPin } from "../src/lib/credentials.js";
```

2. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  };
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}
```

заменить на

<!-- prettier-ignore -->
```ts
  };
}

/**
 * `changes-catalog.json`: two templates, the organization's record with its
 * default templates, a category default, two products (the second archived and
 * a draft), and the tombstones of a category default and a template.
 */
const CATALOG = changesResponseSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/changes-catalog.json", testModuleUrl), "utf8"),
  ),
);
const BOX_58 = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
const MILK_58 = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
/** The template `CATALOG` deletes. */
const OLD_TEMPLATE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const MILK = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
const KEFIR = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
/** A small layout: to the sync a layout is one opaque object. */
const LAYOUT = { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] };

function product(id: string, rev: number, data: object = {}): ChangeItem {
  return {
    entity: "products",
    id,
    rev,
    deleted: false,
    data: {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л",
      printName: null,
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: 40,
      shelfLifeDays: 10,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
      ...data,
    },
  };
}

function template(id: string, rev: number, data: object = {}): ChangeItem {
  return {
    entity: "label_templates",
    id,
    rev,
    deleted: false,
    data: {
      name: "Коробка 58×40",
      purpose: "box",
      enabled: true,
      chzProductGroupCodes: null,
      stock: false,
      spec: LAYOUT,
      ...data,
    },
  };
}

/** A category's default template, keyed `<code>:<purpose>` as the feed keys it. */
function categoryDefault(
  code: number,
  purpose: string,
  rev: number,
  data: object = {},
): ChangeItem {
  return {
    entity: "category_template_defaults",
    id: `${code}:${purpose}`,
    rev,
    deleted: false,
    data: { chzProductGroupCode: code, purpose, templateId: MILK_58, ...data },
  };
}

/** The catalog copies as plain rows; a template's layout is left to its own test. */
function catalog(db: DatabaseSync) {
  const rows = (sql: string) => Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  return {
    products: rows(
      "SELECT id, gtin14, name, print_name, chz_group_code, box_capacity, pallet_box_capacity, " +
        "shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status, " +
        "rev FROM ref_products ORDER BY id",
    ),
    templates: rows(
      "SELECT id, name, purpose, enabled, category_codes, stock, rev FROM ref_templates ORDER BY id",
    ),
    defaults: rows(
      "SELECT id, chz_group_code, purpose, template_id, rev FROM ref_template_defaults ORDER BY id",
    ),
  };
}

/** The organization's three default templates on its copy. */
function orgDefaults(db: DatabaseSync) {
  const sql =
    "SELECT default_box_template_id, default_pallet_template_id, default_duplicate_template_id " +
    "FROM ref_org";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}
```

3. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  "ref_lines",
  "ref_operators",
  "ref_operator_badges",
  "sync_quarantine",
  "sync_state",
];
```

заменить на

<!-- prettier-ignore -->
```ts
  "ref_lines",
  "ref_operators",
  "ref_operator_badges",
  "ref_products",
  "ref_templates",
  "ref_template_defaults",
  "sync_quarantine",
  "sync_state",
];
```

4. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
describe("ENTITY_SET", () => {
  it("names the kept entities and the version of their records", () => {
    // Derived from the entity table and `SYNC_SCHEMA_VERSION`; pinned so a
    // build cannot change one and forget the other.
    expect(ENTITY_SET).toBe("org_profile,site,lines,operators,operator_badges;v3");
  });
});

describe("reference sync", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
describe("ENTITY_SET", () => {
  it("names the kept entities and the version of their records", () => {
    // Derived from the entity table and `SYNC_SCHEMA_VERSION`; pinned so a
    // build cannot change one and forget the other.
    expect(ENTITY_SET).toBe(
      "org_profile,site,lines,operators,operator_badges,products,label_templates," +
        "category_template_defaults;v4",
    );
  });
});

describe("reference sync", () => {
```

5. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    // Products come with plan 1e.
    const product: ChangeItem = {
      entity: "products",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { gtin14: "04600682000013" },
    };
    const changes = feed({ 0: page(42, [product, line(LINE_1, 42, "Линия 1")]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
```

заменить на

<!-- prettier-ignore -->
```ts
  });

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    // Shifts would come with plan 2a.
    const shift: ChangeItem = {
      entity: "shifts",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { number: "0042" },
    };
    const changes = feed({ 0: page(42, [shift, line(LINE_1, 42, "Линия 1")]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
```

6. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      badge("9b2e4a6c-0000-4000-8000-000000000001", 42, ANNA, {
        badgePhc: PIN_PHC.replace("100000", "200000"),
      }),
    ];
    await expect(
      syncReferences({
```

заменить на

<!-- prettier-ignore -->
```ts
      badge("9b2e4a6c-0000-4000-8000-000000000001", 42, ANNA, {
        badgePhc: PIN_PHC.replace("100000", "200000"),
      }),
      // A product never leaves as a tombstone; its unreadable record takes
      // the delete all the same.
      product(MILK, 42),
      product(KEFIR, 42, { status: "blocked" }),
      { entity: "label_templates", id: OLD_TEMPLATE, rev: 40, deleted: true },
      template(BOX_58, 42),
      template(MILK_58, 42, { spec: [] }),
      { entity: "category_template_defaults", id: "15:pallet", rev: 40, deleted: true },
      categoryDefault(8, "box", 42),
      categoryDefault(8, "pallet", 42, { templateId: "7" }),
    ];
    await expect(
      syncReferences({
```

7. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 5 });
    // The `host_id` stamp, then the page: the guard, the wipe (5 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 5 + 6 = 21. Each new entity adds 3 (a wipe, a delete, an upsert):
    // plan 1e's products, templates and their defaults would make it 30, the
    // most the shell's 32 takes.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 21]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 8 });
    // The `host_id` stamp, then the page: the guard, the wipe (8 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 8 + 6 = 30, within the shell's 32. A ninth entity would make it 33.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 30]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});
```

8. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});

describe("sync scheduler", () => {
  it("runs one sync at a time and exactly once more for triggers during a run", async () => {
    const finish: Array<() => void> = [];
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

describe("catalog copies", () => {
  it("keeps the catalog fixture's templates, category default and products with their flags and nulls, and applies its tombstones", async () => {
    const { db, executor } = openLocalDb();
    // Synced before the fixture's page: the template and the category default it deletes.
    await syncReferences({
      changes: feed({
        0: page(60, [
          template(OLD_TEMPLATE, 50),
          categoryDefault(15, "pallet", 51, { templateId: OLD_TEMPLATE }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(catalog(db).templates).toHaveLength(1);
    expect(catalog(db).defaults).toHaveLength(1);
    await expect(
      syncReferences({ changes: feed({ 60: CATALOG }), local: executor, hostId: HOST_ID }),
    ).resolves.toEqual({ kind: "synced", rev: 67, quarantined: 0 });
    expect(catalog(db)).toEqual({
      products: [
        {
          id: KEFIR,
          gtin14: "04600682000020",
          name: "Кефир 1% 0,9 л",
          print_name: null,
          chz_group_code: null,
          box_capacity: null,
          pallet_box_capacity: null,
          shelf_life_days: null,
          default_box_template_id: null,
          default_pallet_template_id: null,
          archived: 1,
          status: "draft",
          rev: 66,
        },
        {
          id: MILK,
          gtin14: "04600682000013",
          name: "Молоко 3,2% 0,9 л",
          print_name: "Молоко 3,2%",
          chz_group_code: 8,
          box_capacity: 12,
          pallet_box_capacity: 40,
          shelf_life_days: 10,
          default_box_template_id: MILK_58,
          default_pallet_template_id: null,
          archived: 0,
          status: "active",
          rev: 65,
        },
      ],
      templates: [
        {
          id: BOX_58,
          name: "Коробка 58×40",
          purpose: "box",
          enabled: 1,
          category_codes: null,
          stock: 1,
          rev: 61,
        },
        {
          id: MILK_58,
          name: "Молоко 58×40",
          purpose: "box",
          enabled: 1,
          category_codes: "[8]",
          stock: 0,
          rev: 62,
        },
      ],
      defaults: [{ id: "8:box", chz_group_code: 8, purpose: "box", template_id: MILK_58, rev: 64 }],
    });
    expect(orgDefaults(db)).toEqual([
      {
        default_box_template_id: BOX_58,
        default_pallet_template_id: null,
        default_duplicate_template_id: null,
      },
    ]);
    expect(tables(db).state).toEqual(state(67));
  });

  it("stores a layout as the JSON text JavaScript writes for it: integer-like keys first", async () => {
    const { db, executor } = openLocalDb();
    const spec = { widthMm: 58, "10": "ten", "2": "two", elements: [{ kind: "field" }] };
    await syncReferences({
      changes: feed({ 0: page(67, [...CATALOG.items, template(MILK_58, 68, { spec })]) }),
      local: executor,
      hostId: HOST_ID,
    });
    const rows = Array.from(
      db
        .prepare(
          "SELECT id, spec, json_extract(spec, '$.elements[1].format') AS format FROM ref_templates ORDER BY id",
        )
        .all(),
      (row) => ({ ...row }),
    );
    expect(rows).toEqual([
      {
        id: BOX_58,
        spec: JSON.stringify(labelTemplateRecordSchema.parse(CATALOG.items[0]?.data).spec),
        format: "code128",
      },
      {
        id: MILK_58,
        spec: '{"2":"two","10":"ten","widthMm":58,"elements":[{"kind":"field"}]}',
        format: null,
      },
    ]);
  });

  it("reads an organization record from a host before plan 1e1, without default templates, as none", async () => {
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({ changes: feed({ 0: page(41, [ORG]) }), local: executor, hostId: HOST_ID }),
    ).resolves.toEqual({ kind: "synced", rev: 41, quarantined: 0 });
    expect(tables(db).org).toHaveLength(1);
    expect(orgDefaults(db)).toEqual([
      {
        default_box_template_id: null,
        default_pallet_template_id: null,
        default_duplicate_template_id: null,
      },
    ]);
  });

  it("drops a key a newer host adds to a catalog record and keeps the record: the catalog grants no access", async () => {
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({
          0: page(12, [
            product(MILK, 10, { shelfLifeHours: 240 }),
            template(BOX_58, 11, { printer: "zebra" }),
            categoryDefault(8, "box", 12, { since: "2026-10-04" }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    const copies = catalog(db);
    expect([copies.products.length, copies.templates.length, copies.defaults.length]).toEqual([
      1, 1, 1,
    ]);
  });

  it("quarantines a product, a template or a category default this build cannot read, deletes its older copy and applies the rest", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(20, [
          product(MILK, 10),
          product(KEFIR, 11),
          template(BOX_58, 12),
          template(MILK_58, 13),
          categoryDefault(8, "box", 14),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    const changes = feed({
      20: page(30, [
        // A GTIN of 13 digits: no scan would find it.
        product(MILK, 21, { gtin14: "4600682000013" }),
        // A purpose a newer host might add.
        template(BOX_58, 22, { purpose: "case" }),
        // A layout that is no object.
        template(MILK_58, 23, { spec: [] }),
        categoryDefault(8, "box", 24, { templateId: "7" }),
        product(KEFIR, 25, { name: "Кефир 2,5% 0,9 л" }),
      ]),
    });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, now: () => SEEN_AT }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 4 });
    expect(catalog(db).products.map((row) => [row.id, row.name, row.rev])).toEqual([
      [KEFIR, "Кефир 2,5% 0,9 л", 25],
    ]);
    expect(catalog(db).templates).toEqual([]);
    expect(catalog(db).defaults).toEqual([]);
    expect(quarantine(db)).toEqual([
      {
        entity: "category_template_defaults",
        id: "8:box",
        rev: 24,
        reason: "templateId: invalid_format",
        seen_at: SEEN_AT,
      },
      {
        entity: "label_templates",
        id: BOX_58,
        rev: 22,
        reason: "purpose: invalid_value",
        seen_at: SEEN_AT,
      },
      { entity: "label_templates", id: MILK_58, rev: 23, reason: "spec: custom", seen_at: SEEN_AT },
      {
        entity: "products",
        id: MILK,
        rev: 21,
        reason: "gtin14: invalid_format",
        seen_at: SEEN_AT,
      },
    ]);
  });

  it("keeps an archived product and a disabled template as the feed sends them: the copies filter nothing", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(12, [
          product(MILK, 11, { archived: true, chzProductGroupCode: null, status: "draft" }),
          template(BOX_58, 12, { enabled: false, stock: true }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    const copies = catalog(db);
    expect(copies.products.map((row) => [row.id, row.archived, row.status])).toEqual([
      [MILK, 1, "draft"],
    ]);
    expect(copies.templates.map((row) => [row.id, row.enabled, row.stock])).toEqual([
      [BOX_58, 0, 1],
    ]);
  });

  it("applies the catalog page again without changing a record", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({ changes: feed({ 0: CATALOG }), local: executor, hostId: HOST_ID });
    const before = catalog(db);
    // As if the revision were lost: the same page arrives again.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    const recorded = counting(executor);
    await syncReferences({
      changes: feed({ 0: CATALOG }),
      local: recorded.executor,
      hostId: HOST_ID,
    });
    expect(catalog(db)).toEqual(before);
    // The guard, then nothing newer to upsert and nothing older to delete,
    // nothing quarantined to lift; only the sync state is written.
    expect(recorded.batches).toEqual([[1, 0, 0, 0, 0, 0, 0, 0, 3]]);
  });

  it("takes a newer revision of a product, a template and a category default, and keeps each against an older one", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(10, [product(MILK, 10), template(BOX_58, 10), categoryDefault(8, "box", 10)]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    await syncReferences({
      changes: feed({
        10: page(20, [
          product(MILK, 20, {
            printName: "Молоко",
            chzProductGroupCode: null,
            archived: true,
            status: "draft",
          }),
          template(BOX_58, 20, { enabled: false, chzProductGroupCodes: [8, 15] }),
          categoryDefault(8, "box", 20, { templateId: BOX_58 }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    const updated = catalog(db);
    expect(
      updated.products.map((row) => [
        row.print_name,
        row.chz_group_code,
        row.archived,
        row.status,
        row.rev,
      ]),
    ).toEqual([["Молоко", null, 1, "draft", 20]]);
    expect(updated.templates.map((row) => [row.enabled, row.category_codes, row.rev])).toEqual([
      [0, "[8,15]", 20],
    ]);
    expect(updated.defaults.map((row) => [row.template_id, row.rev])).toEqual([[BOX_58, 20]]);
    // The feed never sends an older revision after a newer one, but a stale run can.
    await syncReferences({
      changes: feed({
        20: page(30, [product(MILK, 15), template(BOX_58, 15), categoryDefault(8, "box", 15)]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(catalog(db)).toEqual(updated);
  });

  it("keeps a product and a category default that name a template absent from the copies: no foreign key", async () => {
    // A deleted template's tombstone comes before the products its delete
    // cleared, and a template a copy names may wait in the quarantine.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({
          0: page(12, [
            product(MILK, 11, { defaultBoxTemplateId: MILK_58, defaultPalletTemplateId: BOX_58 }),
            categoryDefault(8, "box", 12),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(catalog(db).templates).toEqual([]);
    expect(catalog(db).products).toHaveLength(1);
    expect(catalog(db).defaults).toHaveLength(1);
  });

  it("keeps two products with one GTIN: the copies hold no uniqueness of their own", async () => {
    // An archived product keeps its GTIN without reserving it, so a product
    // in use can carry the same one; a unique index would fail the page.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({
          0: page(12, [product(KEFIR, 11, { archived: true }), product(MILK, 12)]),
        }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(catalog(db).products.map((row) => row.gtin14)).toEqual([
      "04600682000013",
      "04600682000013",
    ]);
  });

  it("keeps an older product, template or category default out while its newer revision waits in quarantine, even from a stale run of a forgotten pairing with the same host", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(20, [product(MILK, 20), template(BOX_58, 20), categoryDefault(8, "box", 20)]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    // The next sync's fetch stays in flight across `device_forget`.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const stale = syncReferences({ changes: held, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(20));
    // `device_forget` clears every table; the device pairs again with the
    // same host, whose first sync quarantines the newer revisions: values
    // this build does not read.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({
          0: page(40, [
            product(MILK, 35, { status: "blocked" }),
            template(BOX_58, 36, { purpose: "case" }),
            categoryDefault(8, "box", 37, { purpose: "case" }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 3 });
    // The forgotten pairing's page lands last. `hostGuard` lets it through:
    // the new pairing stamped the same `host_id`.
    resolve?.(page(30, [product(MILK, 25), template(BOX_58, 25), categoryDefault(8, "box", 25)]));
    await expect(stale).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 3 });
    expect(catalog(db)).toEqual({ products: [], templates: [], defaults: [] });
    expect(quarantine(db).map((entry) => [entry.entity, entry.id, entry.rev])).toEqual([
      ["category_template_defaults", "8:box", 37],
      ["label_templates", BOX_58, 36],
      ["products", MILK, 35],
    ]);
  });

  it("applies a revision larger than a page's 1 MiB, a template's tombstone and 5000 products, in one batch", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(60, [template(OLD_TEMPLATE, 60)]) }),
      local: executor,
      hostId: HOST_ID,
    });
    // Deleting a template at revision 70 cleared the preference of 5000
    // products: one revision, which the feed never splits.
    const products = Array.from({ length: 5000 }, (_, n) =>
      product(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, 70, {
        gtin14: String(4_600_682_000_000 + n).padStart(14, "0"),
        name: `Товар ${n}: молоко питьевое ультрапастеризованное 3,2%, 0,9 л`,
      }),
    );
    const items: ChangeItem[] = [
      { entity: "label_templates", id: OLD_TEMPLATE, rev: 70, deleted: true },
      ...products,
    ];
    expect(Buffer.byteLength(JSON.stringify(items), "utf8")).toBeGreaterThan(1024 * 1024);
    const recorded = counting(executor);
    await expect(
      syncReferences({
        changes: feed({ 60: page(70, items) }),
        local: recorded.executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 70, quarantined: 0 });
    // The guard, the products' upsert, the templates' delete, the quarantine
    // lift and the sync state: one batch, one JSON parameter per entity.
    expect(recorded.batches).toEqual([[1, 5000, 1, 0, 3]]);
    expect({ ...db.prepare("SELECT count(*) AS n FROM ref_products").get() }).toEqual({ n: 5000 });
  });

  it("stores a layout of about 256 KB whole", async () => {
    const { db, executor } = openLocalDb();
    const elements = Array.from({ length: 1960 }, (_, n) => ({
      kind: "text",
      id: `line-${n}`,
      xMm: 2,
      yMm: 2 + n,
      text: "Состав: молоко нормализованное",
      fontSizePt: 8,
    }));
    const spec = { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl", elements };
    const text = JSON.stringify(spec);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(250 * 1024);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(256 * 1024);
    await syncReferences({
      changes: feed({ 0: page(5, [template(BOX_58, 5, { spec })]) }),
      local: executor,
      hostId: HOST_ID,
    });
    expect({ ...db.prepare("SELECT spec FROM ref_templates").get() }).toEqual({ spec: text });
  });
});

describe("sync scheduler", () => {
  it("runs one sync at a time and exactly once more for triggers during a run", async () => {
    const finish: Array<() => void> = [];
```

9. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  canonicalSaltSchema,
  changesResponseSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  canonicalSaltSchema,
  categoryTemplateDefaultSchema,
  changesResponseSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
```

10. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  lineCreateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  labelTemplateRecordSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  lineCreateSchema,
```

11. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  passwordSetSchema,
  productCreateSchema,
  productGroupSchema,
  productUpdateSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  passwordSetSchema,
  productCreateSchema,
  productGroupSchema,
  productRecordSchema,
  productUpdateSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
```

12. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(changes.items.slice(2).map((item) => [item.entity, item.deleted, item.data])).toEqual([
      ["operator_badges", true, undefined],
      ["operators", true, undefined],
    ]);
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(changes.items.slice(2).map((item) => [item.entity, item.deleted, item.data])).toEqual([
      ["operator_badges", true, undefined],
      ["operators", true, undefined],
    ]);
  });

  it("change feed of the catalog", () => {
    const rawChanges = fixture("changes-catalog.json") as { items: Array<{ data?: unknown }> };
    const changes = changesResponseSchema.parse(rawChanges);
    const raw = (index: number) => rawChanges.items[index]?.data;
    expect(changes.items).toHaveLength(8);
    expect(labelTemplateRecordSchema.parse(changes.items[0]?.data)).toEqual(raw(0));
    expect(labelTemplateRecordSchema.parse(changes.items[1]?.data)).toEqual(raw(1));
    expect(orgRecordSchema.parse(changes.items[2]?.data)).toEqual(raw(2));
    expect(categoryTemplateDefaultSchema.parse(changes.items[3]?.data)).toEqual(raw(3));
    expect(productRecordSchema.parse(changes.items[4]?.data)).toEqual(raw(4));
    expect(productRecordSchema.parse(changes.items[5]?.data)).toEqual(raw(5));
    expect(changes.items.slice(6).map((item) => [item.entity, item.id, item.data])).toEqual([
      ["category_template_defaults", "15:pallet", undefined],
      ["label_templates", "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", undefined],
    ]);
  });
});
```

13. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});

describe("catalog shapes", () => {
  it("read a template-is-default refusal with the defaults the change would break", () => {
    const body = errorBodySchema.parse(fixture("error-template-is-default.json"));
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

describe("catalog feed records, which grant no access", () => {
  const TEMPLATE = feedRecord("changes-catalog.json", 1);
  const ORG = feedRecord("changes-catalog.json", 2);
  const CATEGORY_DEFAULT = feedRecord("changes-catalog.json", 3);
  const PRODUCT = feedRecord("changes-catalog.json", 4);

  it("drop a key a newer host adds, as the organization's and the lines' records do", () => {
    expect(productRecordSchema.parse({ ...PRODUCT, addedLater: true })).toEqual(PRODUCT);
    expect(labelTemplateRecordSchema.parse({ ...TEMPLATE, addedLater: true })).toEqual(TEMPLATE);
    expect(categoryTemplateDefaultSchema.parse({ ...CATEGORY_DEFAULT, addedLater: true })).toEqual(
      CATEGORY_DEFAULT,
    );
  });

  it("refuse a value no station can use: a GTIN of other than 14 digits, an unknown purpose or status, a template id that is no UUID", () => {
    for (const product of [
      { ...PRODUCT, gtin14: "4600682000013" },
      { ...PRODUCT, status: "blocked" },
      { ...PRODUCT, defaultBoxTemplateId: "7" },
    ]) {
      expect(productRecordSchema.safeParse(product).success).toBe(false);
    }
    expect(labelTemplateRecordSchema.safeParse({ ...TEMPLATE, purpose: "case" }).success).toBe(
      false,
    );
    expect(labelTemplateRecordSchema.safeParse({ ...TEMPLATE, spec: [] }).success).toBe(false);
    expect(
      categoryTemplateDefaultSchema.safeParse({ ...CATEGORY_DEFAULT, templateId: "7" }).success,
    ).toBe(false);
  });

  it("read an organization record without its default templates, from a host before plan 1e1, as none", () => {
    const older = Object.fromEntries(
      Object.entries(ORG).filter(([key]) => !key.endsWith("TemplateId")),
    );
    expect(Object.keys(older)).toHaveLength(5);
    expect(orgRecordSchema.parse(older)).toEqual(older);
    expect(orgRecordSchema.safeParse({ ...ORG, defaultBoxTemplateId: "7" }).success).toBe(false);
  });
});

describe("catalog shapes", () => {
  it("read a template-is-default refusal with the defaults the change would break", () => {
    const body = errorBodySchema.parse(fixture("error-template-is-default.json"));
```

14. В `apps/standalone/test/local-executor.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      "ref_operator_badges",
      "ref_operators",
      "ref_org",
      "ref_site",
      "sync_quarantine",
      "sync_state",
    ]);
```

заменить на

<!-- prettier-ignore -->
```ts
      "ref_operator_badges",
      "ref_operators",
      "ref_org",
      "ref_products",
      "ref_site",
      "ref_template_defaults",
      "ref_templates",
      "sync_quarantine",
      "sync_state",
    ]);
```

15. В `apps/standalone/src-tauri/tests/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
            "ref_operator_badges",
            "ref_operators",
            "ref_org",
            "ref_site",
            "sync_quarantine",
            "sync_state"
        ]
```

заменить на

<!-- prettier-ignore -->
```rust
            "ref_operator_badges",
            "ref_operators",
            "ref_org",
            "ref_products",
            "ref_site",
            "ref_template_defaults",
            "ref_templates",
            "sync_quarantine",
            "sync_state"
        ]
```

16. В `apps/standalone/src-tauri/tests/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    );
}

/// Forgetting the device (`device_forget`) clears every table but sqlx's
/// migration journal: tables a later migration adds too, since the list
/// comes from `pragma_table_list`, and in any order despite foreign keys.
```

заменить на

<!-- prettier-ignore -->
```rust
    );
}

/// The limits bound SQL text (64 KB) and the number of values (256), never
/// the size of one value: a feed revision is never split, so one larger than a
/// page's 1 MiB (the wizard's templates, a template delete that clears
/// thousands of products) reaches the shell as one JSON parameter per entity,
/// several MiB long, and must pass whole (plan 1e2).
#[tokio::test]
async fn one_value_of_a_few_mebibytes_passes_the_limits() {
    const UPSERT: &str = "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, \
        stock, spec, rev) \
        SELECT value ->> 'id', value ->> 'name', value ->> 'purpose', value ->> 'enabled', \
        value ->> 'chzProductGroupCodes', value ->> 'stock', value ->> 'spec', value ->> 'rev' \
        FROM json_each(?) WHERE true";
    let (_dir, db) = open().await;
    // Twelve layouts of the host's largest size, 256 KB each.
    let spec = json!({ "widthMm": 58, "filler": "x".repeat(256 * 1024 - 32) });
    let spec_length = spec.to_string().len();
    let page = Value::Array(
        (0..12)
            .map(|n| {
                json!({
                    "id": format!("template-{n:02}"),
                    "name": format!("Шаблон {n}"),
                    "purpose": "box",
                    "enabled": true,
                    "chzProductGroupCodes": null,
                    "stock": false,
                    "spec": spec,
                    "rev": 7
                })
            })
            .collect(),
    )
    .to_string();
    assert!(page.len() > 3 * 1024 * 1024, "{} bytes", page.len());
    assert_eq!(
        db.transaction(vec![statement(UPSERT, json!([page]))]).await,
        Ok(vec![12])
    );
    let stored = db
        .query(
            "SELECT count(*) AS templates, min(length(spec)) AS shortest, \
             max(length(spec)) AS longest FROM ref_templates",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Object(stored[0].clone()),
        json!({ "templates": 12, "shortest": spec_length, "longest": spec_length })
    );
}

/// Forgetting the device (`device_forget`) clears every table but sqlx's
/// migration journal: tables a later migration adds too, since the list
/// comes from `pragma_table_list`, and in any order despite foreign keys.
```

17. В `apps/standalone/src-tauri/tests/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
            "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) \
             VALUES ('lines', ?, 4, 'archived: invalid_type', 1790000000000)",
            json!([LINE_2]),
        ),
    ])
    .await
```

заменить на

<!-- prettier-ignore -->
```rust
            "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) \
             VALUES ('lines', ?, 4, 'archived: invalid_type', 1790000000000)",
            json!([LINE_2]),
        ),
        statement(
            "INSERT INTO ref_products (id, gtin14, name, archived, status, rev) \
             VALUES ('product-1', '04600682000013', 'Молоко', 0, 'draft', 5)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_templates (id, name, purpose, enabled, stock, spec, rev) \
             VALUES ('template-1', 'Коробка', 'box', 1, 0, '{}', 6)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_template_defaults (id, chz_group_code, purpose, template_id, rev) \
             VALUES ('8:box', 8, 'box', 'template-1', 7)",
            json!([]),
        ),
    ])
    .await
```

18. В `apps/standalone/src-tauri/tests/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        .query(
            "SELECT (SELECT count(*) FROM ref_org) + (SELECT count(*) FROM ref_site) \
             + (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) \
             + (SELECT count(*) FROM sync_quarantine) + (SELECT count(*) FROM extra_holder) \
             + (SELECT count(*) FROM extra_item) AS n",
            vec![],
        )
        .await
```

заменить на

<!-- prettier-ignore -->
```rust
        .query(
            "SELECT (SELECT count(*) FROM ref_org) + (SELECT count(*) FROM ref_site) \
             + (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) \
             + (SELECT count(*) FROM sync_quarantine) + (SELECT count(*) FROM ref_products) \
             + (SELECT count(*) FROM ref_templates) + (SELECT count(*) FROM ref_template_defaults) \
             + (SELECT count(*) FROM extra_holder) + (SELECT count(*) FROM extra_item) AS n",
            vec![],
        )
        .await
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/protocol.test.ts test/local-executor.test.ts`
Expected: FAIL — 22 из 283:

- `test/reference-sync.test.ts`: 17 из 55 — `no such table: ref_products` (и `ref_templates`, `no such column: default_box_template_id`; список таблиц `COPY_TABLES`, который очищают тесты, уже называет новые), `ENTITY_SET` — получено `…operator_badges;v3`, худшая порция — `"quarantined": 5` вместо 8, порция с испорченными записями — `"quarantined": 0` вместо 4, ревизия больше 1 МиБ — `expected [ [ 1, 3 ] ] to deeply equal [ [ 1, 5000, 1, +0, 3 ] ]`;
- `test/protocol.test.ts`: 4 из 174 — три `TypeError: Cannot read properties of undefined (reading 'parse')` (или `'safeParse'`): схем записей ленты ещё нет; `read an organization record without its default templates…` — `expected true to be false` (запись организации отбрасывает `defaultBoxTemplateId`, не проверяя его);
- `test/local-executor.test.ts`: 1 из 54 — `has exactly the shell's reference tables`: нет `ref_products`, `ref_template_defaults`, `ref_templates`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`, затем `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --test local_db`
Expected: FAIL — 3 из 12: `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` (в `left` нет трёх новых таблиц), `clearing_the_copies_empties_every_table_but_the_migration_journal` (``called `Result::unwrap()` on an `Err` value: StatementFailed``), `one_value_of_a_few_mebibytes_passes_the_limits` (`left: Err(StatementFailed)`, `right: Ok([12])`).

- [ ] **Step 3: Миграция, записи ленты и сущности синхронизации**

1. Create `apps/standalone/src-tauri/migrations/0004_catalog.sql`:

<!-- prettier-ignore -->
```sql
-- The station's copies of the catalog (stage 1 spec §5.3, plan 1e2): products,
-- label templates and the templates' category defaults, and the
-- organization's three default templates on `ref_org`. The webview's reference
-- sync writes the rows; `device_forget` empties every table
-- (`LocalDb::clear_copies`).
--
-- The copies keep the feed's flags and filter nothing: an archived product and
-- a disabled template stay, and the station chooses among them later (plan
-- 2a). A product never leaves; a deleted template and a cleared category
-- default leave as tombstones. No foreign key and no uniqueness besides the
-- key: within one revision a deleted template's tombstone comes before the
-- products whose preference its delete cleared, a template a copy names may
-- wait in the quarantine, and a copy that refused a row would abort its whole
-- page and stop the sync for good.
ALTER TABLE ref_org ADD COLUMN default_box_template_id TEXT;
ALTER TABLE ref_org ADD COLUMN default_pallet_template_id TEXT;
ALTER TABLE ref_org ADD COLUMN default_duplicate_template_id TEXT;

CREATE TABLE ref_products (
  id TEXT PRIMARY KEY,
  -- 14 digits, as the office saved it.
  gtin14 TEXT NOT NULL,
  name TEXT NOT NULL,
  print_name TEXT,
  chz_group_code INTEGER,
  box_capacity INTEGER,
  pallet_box_capacity INTEGER,
  shelf_life_days INTEGER,
  -- Preferences: the station uses one only while the template still fits.
  default_box_template_id TEXT,
  default_pallet_template_id TEXT,
  archived INTEGER NOT NULL,
  -- `active` or `draft`, as the host computed it.
  status TEXT NOT NULL,
  rev INTEGER NOT NULL
);

-- The station finds a scanned product by its GTIN (plan 2a).
CREATE INDEX ref_products_gtin14 ON ref_products (gtin14);

CREATE TABLE ref_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  -- A JSON array of product-group codes, or NULL for every category.
  category_codes TEXT,
  stock INTEGER NOT NULL,
  -- The layout as JSON text, as the webview wrote what the feed carried.
  spec TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE ref_template_defaults (
  -- The feed's key: `<code>:<purpose>` (`8:box`).
  id TEXT PRIMARY KEY,
  chz_group_code INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  template_id TEXT NOT NULL,
  rev INTEGER NOT NULL
);
```

2. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * every badge hash as `validation_failed`.
 */
export const canonicalSaltSchema = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/);

/** `data` of an `org_profile` item. */
export const orgRecordSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
 * every badge hash as `validation_failed`.
 */
export const canonicalSaltSchema = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/);

/**
 * `data` of an `org_profile` item. The organization's three default templates
 * (plan 1e1) are absent from an older host's record and read as none: a
 * required field would quarantine the record and delete the copy.
 */
export const orgRecordSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
  defaultBoxTemplateId: z.uuid().nullish(),
  defaultPalletTemplateId: z.uuid().nullish(),
  defaultDuplicateTemplateId: z.uuid().nullish(),
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

/**
```

3. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  label: z.string().nullable(),
});
export type OperatorBadgeRecord = z.infer<typeof operatorBadgeRecordSchema>;

/** The signed-in office user. */
export const officeUserSchema = z.object({
```

заменить на

<!-- prettier-ignore -->
```ts
  label: z.string().nullable(),
});
export type OperatorBadgeRecord = z.infer<typeof operatorBadgeRecordSchema>;

/**
 * `data` of a `products` item. The catalog grants no access, so its records
 * are read with `z.object`, as `org_profile` and `lines` are: a key a newer
 * host adds is dropped, and a value this build cannot read quarantines the
 * record. An archived product stays with `archived: true`; a product is never
 * deleted.
 */
export const productRecordSchema = z.object({
  gtin14: z.string().regex(/^[0-9]{14}$/),
  name: z.string(),
  printName: z.string().nullable(),
  chzProductGroupCode: groupCodeSchema.nullable(),
  boxCapacity: countSchema,
  palletBoxCapacity: countSchema,
  shelfLifeDays: countSchema,
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullable(),
  archived: z.boolean(),
  status: productStatusSchema,
});
export type ProductRecord = z.infer<typeof productRecordSchema>;

/**
 * `data` of a `label_templates` item, read as a product's is. A disabled
 * template stays with `enabled: false`; a deleted one leaves as a tombstone.
 * The layout is opaque here (`templateSpecSchema`): the station checks it
 * before it prints (plan 2a).
 */
export const labelTemplateRecordSchema = z.object({
  name: z.string(),
  purpose: templatePurposeSchema,
  enabled: z.boolean(),
  chzProductGroupCodes: groupCodesSchema,
  stock: z.boolean(),
  spec: templateSpecSchema,
});
export type LabelTemplateRecord = z.infer<typeof labelTemplateRecordSchema>;

/** The signed-in office user. */
export const officeUserSchema = z.object({
```

4. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import {
  lineRecordSchema,
  operatorBadgeRecordSchema,
  operatorRecordSchema,
  orgRecordSchema,
  siteRecordSchema,
  type ChangeItem,
  type ChangesResponse,
```

заменить на

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import {
  categoryTemplateDefaultSchema,
  labelTemplateRecordSchema,
  lineRecordSchema,
  operatorBadgeRecordSchema,
  operatorRecordSchema,
  orgRecordSchema,
  productRecordSchema,
  siteRecordSchema,
  type ChangeItem,
  type ChangesResponse,
```

5. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * (`archived: invalid_type`; `data` names the record itself): never a value,
 * since operator records carry PIN and badge hashes. That holds only while
 * every record schema has fixed keys: a `z.record` would put keys taken from
 * the data into the paths.
 */
function quarantineReason(error: z.ZodError): string {
  const reason = error.issues
```

заменить на

<!-- prettier-ignore -->
```ts
 * (`archived: invalid_type`; `data` names the record itself): never a value,
 * since operator records carry PIN and badge hashes. That holds only while
 * every record schema has fixed keys: a `z.record` would put keys taken from
 * the data into the paths, which is why a template's layout is one opaque
 * value (`templateSpecSchema`, a single `custom` issue).
 */
function quarantineReason(error: z.ZodError): string {
  const reason = error.issues
```

6. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * the quarantine's fail-closed delete took away. The feed never sends an older
 * revision after a newer one, but a stale run can: a page fetched before
 * `device_forget` that lands only after a new pairing with the same host has
 * stamped `host_id` again, when `hostGuard` no longer stops it. Only for
 * operators and their badges, not for `site`: its salt never changes after
 * the wizard, so an older revision of it brings back nothing that grants access.
 */
function notQuarantinedNewer(entity: string): string {
  return (
```

заменить на

<!-- prettier-ignore -->
```ts
 * the quarantine's fail-closed delete took away. The feed never sends an older
 * revision after a newer one, but a stale run can: a page fetched before
 * `device_forget` that lands only after a new pairing with the same host has
 * stamped `host_id` again, when `hostGuard` no longer stops it. Operators and
 * their badges carry it, since an older record would bring back access, and
 * the catalog's copies too (products, templates, category defaults), since an
 * older layout or default must not take the place the delete emptied. Not
 * `org_profile`, `site` and `lines` (plan 2a): `site`'s salt never changes
 * after the wizard.
 */
function notQuarantinedNewer(entity: string): string {
  return (
```

7. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
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
```

заменить на

<!-- prettier-ignore -->
```ts
    {
      table: "ref_org",
      check: (item) => checked(orgRecordSchema, item),
      // `->>` yields `gs1Prefixes` as the JSON text of the array, and a
      // default template an older host does not send as NULL.
      upsert:
        "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, " +
        "default_box_template_id, default_pallet_template_id, default_duplicate_template_id, " +
        "rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'inn', value ->> 'gln', " +
        "value ->> 'gs1Prefixes', value ->> 'timeZone', value ->> 'defaultBoxTemplateId', " +
        "value ->> 'defaultPalletTemplateId', value ->> 'defaultDuplicateTemplateId', " +
        "value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, inn = excluded.inn, " +
        "gln = excluded.gln, gs1_prefixes = excluded.gs1_prefixes, " +
        "time_zone = excluded.time_zone, " +
        "default_box_template_id = excluded.default_box_template_id, " +
        "default_pallet_template_id = excluded.default_pallet_template_id, " +
        "default_duplicate_template_id = excluded.default_duplicate_template_id, " +
        "rev = excluded.rev " +
        "WHERE excluded.rev > ref_org.rev",
    },
  ],
```

8. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        "WHERE excluded.rev > ref_operator_badges.rev",
    },
  ],
]);

/**
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE excluded.rev > ref_operator_badges.rev",
    },
  ],
  [
    "products",
    {
      table: "ref_products",
      check: (item) => checked(productRecordSchema, item),
      // `->>` yields `archived` as 1 or 0 and a JSON `null` as NULL.
      upsert:
        "INSERT INTO ref_products (id, gtin14, name, print_name, chz_group_code, box_capacity, " +
        "pallet_box_capacity, shelf_life_days, default_box_template_id, " +
        "default_pallet_template_id, archived, status, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'gtin14', r.value ->> 'name', " +
        "r.value ->> 'printName', r.value ->> 'chzProductGroupCode', r.value ->> 'boxCapacity', " +
        "r.value ->> 'palletBoxCapacity', r.value ->> 'shelfLifeDays', " +
        "r.value ->> 'defaultBoxTemplateId', r.value ->> 'defaultPalletTemplateId', " +
        "r.value ->> 'archived', r.value ->> 'status', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("products") +
        " ON CONFLICT (id) DO UPDATE SET gtin14 = excluded.gtin14, name = excluded.name, " +
        "print_name = excluded.print_name, chz_group_code = excluded.chz_group_code, " +
        "box_capacity = excluded.box_capacity, " +
        "pallet_box_capacity = excluded.pallet_box_capacity, " +
        "shelf_life_days = excluded.shelf_life_days, " +
        "default_box_template_id = excluded.default_box_template_id, " +
        "default_pallet_template_id = excluded.default_pallet_template_id, " +
        "archived = excluded.archived, status = excluded.status, rev = excluded.rev " +
        "WHERE excluded.rev > ref_products.rev",
    },
  ],
  [
    "label_templates",
    {
      table: "ref_templates",
      check: (item) => checked(labelTemplateRecordSchema, item),
      // `->>` yields the categories and the layout as JSON text, and `null`
      // categories (every category) as NULL.
      upsert:
        "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, stock, spec, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'name', r.value ->> 'purpose', " +
        "r.value ->> 'enabled', r.value ->> 'chzProductGroupCodes', r.value ->> 'stock', " +
        "r.value ->> 'spec', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("label_templates") +
        " ON CONFLICT (id) DO UPDATE SET name = excluded.name, purpose = excluded.purpose, " +
        "enabled = excluded.enabled, category_codes = excluded.category_codes, " +
        "stock = excluded.stock, spec = excluded.spec, rev = excluded.rev " +
        "WHERE excluded.rev > ref_templates.rev",
    },
  ],
  [
    "category_template_defaults",
    {
      table: "ref_template_defaults",
      // The feed's id, `<code>:<purpose>`, is the key.
      check: (item) => checked(categoryTemplateDefaultSchema, item),
      upsert:
        "INSERT INTO ref_template_defaults (id, chz_group_code, purpose, template_id, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'chzProductGroupCode', r.value ->> 'purpose', " +
        "r.value ->> 'templateId', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("category_template_defaults") +
        " ON CONFLICT (id) DO UPDATE SET chz_group_code = excluded.chz_group_code, " +
        "purpose = excluded.purpose, template_id = excluded.template_id, rev = excluded.rev " +
        "WHERE excluded.rev > ref_template_defaults.rev",
    },
  ],
]);

/**
```

9. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * Raise it whenever either changes: the stored `entity_set` then no longer
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 3;

/**
 * This build's copies, in `sync_state.entity_set`: the feed entities it
 * keeps (derived from `ENTITIES`, so a new entity cannot update that map and
 * forget this value, or the reverse) and `SYNC_SCHEMA_VERSION`. Today:
 * `"org_profile,site,lines,operators,operator_badges;v3"`. A build that
 * keeps other entities, or reads them differently, finds another value there
 * and syncs from zero: records the old build skipped or quarantined would
 * never come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys()].join(",")};v${SYNC_SCHEMA_VERSION}`;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
 * Raise it whenever either changes: the stored `entity_set` then no longer
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 4;

/**
 * This build's copies, in `sync_state.entity_set`: the feed entities it
 * keeps (derived from `ENTITIES`, so a new entity cannot update that map and
 * forget this value, or the reverse) and `SYNC_SCHEMA_VERSION`, eight
 * entities and `v4` today (`test/reference-sync.test.ts` pins the text). A
 * build that keeps other entities, or reads them differently, finds another
 * value there and syncs from zero: records the old build skipped or
 * quarantined would never come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys()].join(",")};v${SYNC_SCHEMA_VERSION}`;

/**
```

10. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
 * statements — 21 for the five kept today, and E = 8 (30) at most within the
 * shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
```

заменить на

<!-- prettier-ignore -->
```ts
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
 * statements — 30 for the eight kept today, the most within the shell's 32: a
 * ninth entity would need 33. A revision larger than a page's byte bound
 * still comes whole, as one JSON parameter per entity: the shell bounds SQL
 * text and the number of values, not a value's size.
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/protocol.test.ts test/local-executor.test.ts`
Expected: PASS — 283 теста (55, 174 и 54).

Run: то же с `--reporter=verbose` — stderr пуст; затем те же файлы под стендом с задержкой `setImmediate` — PASS, 283.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --test local_db`
Expected: PASS — 12 тестов.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/local/reference-sync.ts` снять защиту с товаров: фрагмент

<!-- prettier-ignore -->
```ts
        notQuarantinedNewer("products") +
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE true" +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "keeps an older product"`
Expected: FAIL — `expected { products: [ { …(13) } ], …(2) } to deeply equal { products: [], templates: [], …(1) }`.

Мутация 2. В `apps/standalone/src/local/reference-sync.ts` снять защиту с шаблонов: фрагмент

<!-- prettier-ignore -->
```ts
        notQuarantinedNewer("label_templates") +
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE true" +
```

Run: та же команда, что у мутации 1.
Expected: FAIL — `expected { products: [], …(2) } to deeply equal { products: [], templates: [], …(1) }`: в копии вернулся старый шаблон `"name": "Коробка 58×40"`.

Мутация 3. В `apps/standalone/src/local/reference-sync.ts` снять защиту с умолчаний категорий: фрагмент

<!-- prettier-ignore -->
```ts
        notQuarantinedNewer("category_template_defaults") +
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE true" +
```

Run: та же команда, что у мутации 1.
Expected: FAIL — в копии вернулось старое умолчание: `"id": "8:box"`.

Мутация 4. В `apps/standalone/src-tauri/migrations/0004_catalog.sql` связать предпочтение товара с шаблоном внешним ключом: фрагмент

<!-- prettier-ignore -->
```sql
  default_box_template_id TEXT,
  default_pallet_template_id TEXT,
  archived INTEGER NOT NULL,
```

заменить на

<!-- prettier-ignore -->
```sql
  default_box_template_id TEXT REFERENCES ref_templates (id),
  default_pallet_template_id TEXT,
  archived INTEGER NOT NULL,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "no foreign key"`
Expected: FAIL — `FOREIGN KEY constraint failed`.

Мутация 5. В `apps/standalone/src-tauri/migrations/0004_catalog.sql` сделать индекс GTIN уникальным: фрагмент

<!-- prettier-ignore -->
```sql
CREATE INDEX ref_products_gtin14 ON ref_products (gtin14);
```

заменить на

<!-- prettier-ignore -->
```sql
CREATE UNIQUE INDEX ref_products_gtin14 ON ref_products (gtin14);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "keeps two products with one GTIN"`
Expected: FAIL — `UNIQUE constraint failed: ref_products.gtin14`.

Мутация 6. В `apps/standalone/src/host/protocol.ts` потребовать шаблон короба в записи организации: фрагмент

<!-- prettier-ignore -->
```ts
  defaultBoxTemplateId: z.uuid().nullish(),
  defaultPalletTemplateId: z.uuid().nullish(),
```

заменить на

<!-- prettier-ignore -->
```ts
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullish(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/protocol.test.ts -t "before plan 1e1"`
Expected: FAIL — 2 теста: `Invalid input: expected string, received undefined` и в синхронизации `"quarantined": 1` вместо `0`.

Мутация 7. В `apps/standalone/src/local/reference-sync.ts` дать старой ревизии товара перезаписать новую: фрагмент

<!-- prettier-ignore -->
```ts
        "archived = excluded.archived, status = excluded.status, rev = excluded.rev " +
        "WHERE excluded.rev > ref_products.rev",
```

заменить на

<!-- prettier-ignore -->
```ts
        "archived = excluded.archived, status = excluded.status, rev = excluded.rev",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "keeps each against an older one"`
Expected: FAIL — `expected { products: [ { …(13) } ], …(2) } to deeply equal { products: [ { …(13) } ], …(2) }`: в копии ревизия 15 вместо 20.

Мутация 8. В `apps/standalone/src/host/protocol.ts` читать запись шаблона строго: фрагмент

<!-- prettier-ignore -->
```ts
export const labelTemplateRecordSchema = z.object({
```

заменить на

<!-- prettier-ignore -->
```ts
export const labelTemplateRecordSchema = z.strictObject({
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/protocol.test.ts -t "newer host adds"`
Expected: FAIL — 2 теста: `ZodError` в `drop a key a newer host adds…` и в синхронизации `"quarantined": 1` вместо `0`.

Мутация 9. В `apps/standalone/src/host/protocol.ts` не проверять, что GTIN записи — 14 цифр: фрагмент

<!-- prettier-ignore -->
```ts
export const productRecordSchema = z.object({
  gtin14: z.string().regex(/^[0-9]{14}$/),
```

заменить на

<!-- prettier-ignore -->
```ts
export const productRecordSchema = z.object({
  gtin14: z.string(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/protocol.test.ts -t "cannot read|no station can use"`
Expected: FAIL — 2 теста: `expected true to be false` и в синхронизации `"quarantined": 3` вместо `4`.

Мутация 10. В `apps/standalone/src-tauri/src/local_db.rs` (файл задача не меняет) отвергнуть строку длиннее 1 МиБ: фрагмент

<!-- prettier-ignore -->
```rust
            Value::String(value) => query.bind(value),
```

заменить на

<!-- prettier-ignore -->
```rust
            Value::String(value) if value.len() > 1024 * 1024 => {
                return Err(LocalDbError::UnsupportedValue)
            }
            Value::String(value) => query.bind(value),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --test local_db one_value_of_a_few_mebibytes`
Expected: FAIL — `left: Err(UnsupportedValue)`, `right: Ok([12])`.

Мутация 11. В `apps/standalone/src-tauri/src/local_db.rs` не очищать таблицы каталога: фрагмент

<!-- prettier-ignore -->
```rust
             AND name NOT GLOB 'sqlite_*' ORDER BY name",
```

заменить на

<!-- prettier-ignore -->
```rust
             AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'ref_[pt]*' ORDER BY name",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --test local_db clearing_the_copies_empties`
Expected: FAIL — `left: Object {"n": Number(3)}`, `right: Object {"n": Number(0)}`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
host adds never just drops away on an older station. `org_profile` and
`lines` are read with `z.object`, which drops unknown keys. An operator is in
the feed only while active: a deactivation writes a tombstone for its id, and
a reactivation drops the tombstone and sends the record again with a new
`rev`. A badge is in the feed only while not revoked: a revocation writes a
```

заменить на

<!-- prettier-ignore -->
```text
host adds never just drops away on an older station. `org_profile`, `lines`
and the catalog's records (`products`, `label_templates`,
`category_template_defaults`) are read with `z.object`, which drops unknown
keys; a value this build cannot read (an unknown purpose or status, a GTIN
of other than 14 digits, a template id that is no UUID) still quarantines
the record. An operator is in the feed only while active: a deactivation
writes a tombstone for its id, and a reactivation drops the tombstone and
sends the record again with a new `rev`. A badge is in the feed only while
not revoked: a revocation writes a
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
there changes `ENTITY_SET` and makes every device sync from zero once. It
also adds three statements to the worst-case page batch (see "Reference
sync"), which must stay within the shell's 32.
```

заменить на

<!-- prettier-ignore -->
```text
there changes `ENTITY_SET` and makes every device sync from zero once. It
also adds three statements to the worst-case page batch (see "Reference
sync"), which must stay within the shell's 32: the eight entities kept
since plan 1e2 take 30, so a ninth needs a smaller batch first.
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
BLOBs. A large reference page goes in as one JSON parameter per entity
through `json_each`, so the limits bound SQL, not rows. Rejections are bare
codes: `local_db_unavailable` (the database did not open; the app starts
anyway), `invalid_statement`, `unsupported_value`, `statement_failed`,
`changes_mismatch`.
```

заменить на

<!-- prettier-ignore -->
```text
BLOBs. A large reference page goes in as one JSON parameter per entity
through `json_each`, so the limits bound SQL, not rows, and never the size
of one value: a feed revision larger than a page's 1 MiB (the wizard's
templates, a template delete that clears thousands of products) comes as a
parameter of several MiB and passes whole (`tests/local_db.rs` pins it).
Rejections are bare codes: `local_db_unavailable` (the database did not
open; the app starts anyway), `invalid_statement`, `unsupported_value`,
`statement_failed`, `changes_mismatch`.
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
change there means updating `test/support/local-db.ts` too and adding a case
to `src-tauri/tests/fixtures/local-sql.json`.

`device_forget` clears the local copies before it removes `device.json`:
```

заменить на

<!-- prettier-ignore -->
```text
change there means updating `test/support/local-db.ts` too and adding a case
to `src-tauri/tests/fixtures/local-sql.json`.

The catalog's copies come from `src-tauri/migrations/0004_catalog.sql`:
`ref_products`, `ref_templates` (the layout as JSON text, the categories as a
JSON array, NULL for every category) and `ref_template_defaults` (keyed
`<code>:<purpose>`, as the feed keys them), and the organization's three
default templates as columns of `ref_org`. They keep the feed's flags
(`archived`, `enabled`, `status`) and filter nothing: the station chooses
among them later (plan 2a). They have no foreign key and no uniqueness
besides the key, for the reasons the migration gives (an archived product
keeps a GTIN that a product in use may hold too); `ref_products_gtin14` is a
plain index for plan 2a's lookup of a scanned product. `0001`'s header still
says products and templates «join with plans 1d and 1e», which `0004` did;
an applied migration is never edited.

`device_forget` clears the local copies before it removes `device.json`:
```

5. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
operator records carry PIN and badge hashes. That is safe only because
every record schema has fixed keys: a schema with a dynamic-key `z.record`
would put keys taken from the data into the paths. `seen_at` is a
parameter from the webview's clock, never SQL time. Entities this build
does not keep are skipped, not quarantined, and applying a page again
changes nothing. A successful run reports the quarantine's size
```

заменить на

<!-- prettier-ignore -->
```text
operator records carry PIN and badge hashes. That is safe only because
every record schema has fixed keys: a schema with a dynamic-key `z.record`
would put keys taken from the data into the paths. A template's layout is
therefore one opaque object (`templateSpecSchema`, one `custom` issue),
never checked at sync time: the station checks it where it prints (plan
2a). A copy's `spec` is the text `JSON.stringify` gives for the parsed
layout, which puts integer-like keys first, so it is not the host's
byte-ordered text: whatever digests a layout (plan 2a's layout snapshots)
canonicalizes it first. `seen_at` is a parameter from the webview's clock,
never SQL time. Entities this build does not keep are skipped, not
quarantined, and applying a page again changes nothing. A successful run
reports the quarantine's size
```

6. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
two per entity, the quarantine upsert and lift, and the sync state. That
is 21 for the five entities kept today, within the shell's 32 (E = 8 at
most, 30 statements); a test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines,operators,operator_badges;v3"`): raise the
version whenever a record schema or the meaning of a copy table changes,
so every device syncs from zero once and gets back what an older build
quarantined or kept differently.
The upserts of operators and badges also skip a record whose newer
revision waits in the quarantine (`notQuarantinedNewer`): the insert would
otherwise bring back what the quarantine's fail-closed delete took away.
```

заменить на

<!-- prettier-ignore -->
```text
two per entity, the quarantine upsert and lift, and the sync state. That
is 30 for the eight entities kept today, the most the shell's 32 takes: a
ninth entity needs a smaller batch first. A test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults;v4"`):
raise the version whenever a record schema or the meaning of a copy table
changes, so every device syncs from zero once and gets back what an older
build quarantined or kept differently.
The upserts of operators, badges and the catalog's copies (products, label
templates and category defaults) also skip a record whose newer revision
waits in the quarantine (`notQuarantinedNewer`): the insert would otherwise
bring back what the quarantine's fail-closed delete took away, an access
for a person or an older layout or default for the catalog. The
`org_profile`, `site` and `lines` upserts have no such guard (plan 2a).
```

7. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  JSON, а не как текст. Внутри одной ревизии надгробие удалённого шаблона идёт
  раньше товаров, у которых удаление сняло ссылку (сущности упорядочены по
  имени), поэтому копии станции не держат внешних ключей на шаблоны.
```

заменить на

<!-- prettier-ignore -->
```text
  JSON, а не как текст. Внутри одной ревизии надгробие удалённого шаблона идёт
  раньше товаров, у которых удаление сняло ссылку (сущности упорядочены по
  имени), поэтому копии станции не держат внешних ключей на шаблоны. Записи
  каталога вебвью читает через `z.object` (план 1e2): незнакомое поле
  отбрасывается, а значение, которое сборка прочесть не может (неизвестные
  назначение или статус, GTIN не из 14 цифр, идентификатор шаблона не UUID),
  уводит запись в карантин; макет — один непрозрачный объект, его схему
  станция проверяет перед печатью (план 2a).
```

8. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
Формы плана 1e1 (схемы Zod к ним — план 1e2):
```

заменить на

<!-- prettier-ignore -->
```text
Формы плана 1e1 (Vitest разбирает их схемами Zod с плана 1e2):
```

9. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
`category_template_defaults` появились в плане 1e1 (хост); таблицы
`ref_products`, `ref_templates` и `ref_template_defaults` на станции добавит
план 1e2.
```

заменить на

<!-- prettier-ignore -->
```text
`category_template_defaults` появились в плане 1e1 (хост); таблицы
`ref_products`, `ref_templates`, `ref_template_defaults` и три столбца
шаблонов по умолчанию у `ref_org` на станции добавил план 1e2 (миграция
`0004_catalog.sql`): без внешних ключей на шаблоны и без уникальности, кроме
ключа; копии хранят признаки `archived`, `enabled` и `status` и ничего не
отбирают.
```

10. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  пишет хост), уводят запись в карантин. Upsert операторов и бейджей не
  возвращает старую ревизию записи, более новая ревизия которой ждёт в
  карантине;
- сохранённый набор сущностей (`entity_set`) несёт и версию схемы записей
  (`org_profile,site,lines,operators,operator_badges;v3`): смена схемы записи
  или смысла таблицы копий поднимает версию, и каждое устройство один раз
  синхронизируется с нуля;
```

заменить на

<!-- prettier-ignore -->
```text
  пишет хост), уводят запись в карантин. Upsert операторов, бейджей и копий
  каталога не возвращает старую ревизию записи, более новая ревизия которой
  ждёт в карантине;
- сохранённый набор сущностей (`entity_set`) несёт и версию схемы записей
  (`org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults;v4`):
  смена схемы записи или смысла таблицы копий поднимает версию, и каждое
  устройство один раз синхронизируется с нуля;
```

11. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  роняет обе проверки. (Фикстуры плана 1e1 — товарные группы, товары, шаблоны,
  умолчания, лента каталога, мастер с шаблонами, правило слота — пока проверяет
  только Rust: схемы Zod к ним, записи `ENTITIES` и копии станции — план 1e2,
  `templates` мастера — план 1e3.)
```

заменить на

<!-- prettier-ignore -->
```text
  роняет обе проверки. (Фикстуры плана 1e1 — товарные группы, товары, шаблоны,
  умолчания, лента каталога, мастер с шаблонами, правило слота — Vitest разбирает
  с плана 1e2; мастер с шаблонами — строгой схемой запроса, а шлёт `templates`
  только мастер плана 1e3.)
```

Перечитать изменённые разделы целиком: «Change feed», «Local database» и «Reference sync» в `AGENTS.md` (числа E = 8, 30 операторов, `v4`; нигде не осталось «21» и «five entities»), §4.4, §4.5, §5.3, §5.4 и §6 спецификации.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -nF '\u0' apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/migrations/0004_catalog.sql`
Expected: чисто; первый `grep` находит только `src/host/pairing-code.ts:66`, второй — ничего.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 38 файлов, 901 тест (884 + 17).

```bash
git add apps/standalone/src-tauri/migrations/0004_catalog.sql apps/standalone/src/host/protocol.ts apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/src-tauri/tests/local_db.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): копии каталога на станции — миграция 0004, записи ленты, синхронизация v4" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Страница «Товары» — раздел «Каталог», список, поиск, отбор, страницы

В меню офиса появляется раздел «Каталог» с пунктом «Товары» (обе роли), маршрут `/products` и страница — урезанный перенос `apps/admin/src/pages/catalog` (D8). Хост отдаёт список целиком, с архивными, поэтому сортировка, поиск, отбор по состоянию и страницы — в вебвью: действующие первыми, по названию с числами по значению (`activeFirstByName`; хост сортирует побайтно); поиск без учёта регистра по названию, названию для печати и GTIN (в GTIN пробелы поиска не считаются: «4600 682» находит 04600682000013); отбор «Все» / «Черновик» / «Активен» / «В архиве»; страницы по 25 строк, новый поиск или отбор возвращает на первую. Название группы берётся из справочника хоста (он статичен: `staleTime: Infinity`), код без названия показывается кодом, а если справочник не загрузился, список остаётся с кодами и предупреждением с «Повторить». Состояние — словом в `StatusChip`. «Ничего не найдено» и «Товаров пока нет» — разные тексты.

Кнопок записи в этой задаче нет: «Добавить товар», «Изменить» и диалог приходят в задаче 5 вместе. Список шаблонов страница не читает (его читает только диалог, задача 6), поэтому его сбой не может спрятать список.

**Files:**

- Create: `apps/standalone/src/office/products/ProductsPage.tsx`, `apps/standalone/src/office/products/product-list.ts`, `apps/standalone/src/office/products/product-queries.ts`
- Modify: `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/products-page.test.tsx` (Create)
- Modify: `apps/standalone/AGENTS.md` («App shell», «Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `HostApi.listProducts`, `HostApi.listProductGroups`, `type OfficeProduct`, `type ProductGroup` (задача 2);
  - `useOfficeQuery(key, read, options?)`, `officeKeys` — `src/office/office-query.ts`; `activeFirstByName` — `src/office/records.tsx`; `LoadError`, `PageLoading` — `src/office/page-state.tsx`; `OFFICE_NAV` — `src/office/nav.ts`;
  - `fakeOfficeSession`, `renderOffice`, `TECHNOLOGIST`, `type FakeOfficeSession` — `test/support/office.tsx`.
- Produces:
  - `officeKeys.productGroups` (`["office", "product-groups"]`), `officeKeys.products` (`["office", "products"]`);
  - `useProductGroups()` — `src/office/products/product-queries.ts` (`staleTime: Infinity`);
  - `src/office/products/product-list.ts`: `type ProductState = "draft" | "active" | "archived"`, `productState(product)`, `type ProductFilter = "all" | ProductState`, `PAGE_SIZE = 25`, `matchesSearch(product, search): boolean`, `findProducts(products, search, filter)`, `groupLabel(groups, code, t): string`;
  - `ProductsPage` — `src/office/products/ProductsPage.tsx`; классы `.product-name`, `.product-name__print`, `.office-pager` — `src/app/shell.css`;
  - ключи `office.nav.sections.catalog`, `office.nav.products` и группа `office.products` (`title`, `filters`, `search`, `searchHint`, `stateFilter`, `found`, `states.*`, `table.*`, `printNameShort`, `unknownGroup`, `groupsFailed`, `empty`, `nothingFound`, `pager.*`).

- [ ] **Step 1: Тест (падающий)**

1. Create `apps/standalone/test/products-page.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import { matchesSearch } from "../src/office/products/product-list.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
];

const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: null,
  defaultPalletTemplateId: null,
  archived: false,
  status: "active",
  rev: 65,
};
/** A draft: no group, no capacities; its print name is its name. */
const WATER_2: OfficeProduct = {
  ...MILK,
  id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
  gtin14: "04601234000017",
  name: "Вода 2",
  printName: "Вода 2",
  chzProductGroupCode: null,
  boxCapacity: null,
  palletBoxCapacity: null,
  status: "draft",
  rev: 70,
};
/** In a group the host's lookup does not have. */
const WATER_10: OfficeProduct = {
  ...MILK,
  id: "3c4d5e6f-7081-4923-8b4c-5d6e7f809102",
  gtin14: "04602222000026",
  name: "Вода 10",
  printName: null,
  chzProductGroupCode: 99,
  boxCapacity: 6,
  rev: 71,
};
const AYRAN: OfficeProduct = {
  ...MILK,
  id: "4d5e6f70-8192-4a34-9c5d-6e7f80910213",
  gtin14: "04605555000015",
  name: "Айран",
  printName: null,
  archived: true,
  rev: 72,
};

function session(products: OfficeProduct[] = [WATER_10, WATER_2, MILK, AYRAN]): FakeOfficeSession {
  const fake = fakeOfficeSession();
  // The host's own order (archived last, names bytewise): the page sorts again.
  fake.api.listProducts.mockResolvedValue(products);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function openProducts(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
  await screen.findByRole("heading", { name: "Товары" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The names column, top to bottom: each product's name, without its print name. */
function names(): (string | null | undefined)[] {
  return rows().map(
    (row) => within(row).getAllByRole("cell")[1]?.firstElementChild?.firstElementChild?.textContent,
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("office products", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu under «Каталог» for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      expect(await screen.findByRole("link", { name: "Товары" })).toBeTruthy();
      expect(screen.getByText("Каталог")).toBeTruthy();
      view.unmount();
    }
  });

  it("lists the products active first, by name with numbers in order, archived ones last", async () => {
    await openProducts(session());
    expect(names()).toEqual(["Вода 2", "Вода 10", "Молоко 3,2% 0,9 л", "Айран"]);
  });

  it("shows the GTIN, the group's name or its code, the box capacity and the state in words", async () => {
    await openProducts(session());
    const milk = within(rowOf("Молоко 3,2% 0,9 л"));
    expect(milk.getByText("04600682000013")).toBeTruthy();
    expect(milk.getByText("Молочная продукция")).toBeTruthy();
    expect(milk.getByText("12")).toBeTruthy();
    expect(milk.getByText("Активен")).toBeTruthy();
    const draft = within(rowOf("Вода 2"));
    expect(draft.getAllByText("—")).toHaveLength(2);
    expect(draft.getByText("Черновик")).toBeTruthy();
    expect(within(rowOf("Вода 10")).getByText("Код 99")).toBeTruthy();
    expect(within(rowOf("Айран")).getByText("В архиве")).toBeTruthy();
  });

  it("shows the print name as a second line only when it differs from the name", async () => {
    await openProducts(session());
    expect(within(rowOf("Молоко 3,2% 0,9 л")).getByText("Для печати: Молоко 3,2%")).toBeTruthy();
    expect(screen.queryByText("Для печати: Вода 2")).toBeNull();
    expect(screen.getAllByText(/^Для печати:/)).toHaveLength(1);
  });

  it("finds products by name, print name or GTIN, without case and with spaces in a GTIN", async () => {
    await openProducts(session());
    const search = screen.getByLabelText("Поиск");
    fireEvent.change(search, { target: { value: "ВОДА" } });
    expect(names()).toEqual(["Вода 2", "Вода 10"]);
    expect(screen.getByText("Найдено: 2 из 4")).toBeTruthy();
    fireEvent.change(search, { target: { value: " 4602 222 " } });
    expect(names()).toEqual(["Вода 10"]);
    fireEvent.change(search, { target: { value: "3,2%" } });
    expect(names()).toEqual(["Молоко 3,2% 0,9 л"]);
    fireEvent.change(search, { target: { value: "" } });
    expect(names()).toHaveLength(4);
  });

  it("matches a search the way the list does", () => {
    const product = { name: "Молоко 3,2% 0,9 л", printName: "Молоко", gtin14: "04600682000013" };
    for (const text of ["", "  ", "молоко", "МОЛОКО 3,2", "4600 682", "04600682000013", "0013"]) {
      expect(matchesSearch(product, text), text).toBe(true);
    }
    for (const text of ["кефир", "4601", "460 0x"]) {
      expect(matchesSearch(product, text), text).toBe(false);
    }
    expect(matchesSearch({ ...product, name: "Йогурт", printName: "Молочный" }, "молоч")).toBe(
      true,
    );
  });

  it("keeps only the drafts, the active or the archived products with the state filter", async () => {
    await openProducts(session());
    const filter = screen.getByLabelText("Состояние");
    fireEvent.change(filter, { target: { value: "draft" } });
    expect(names()).toEqual(["Вода 2"]);
    fireEvent.change(filter, { target: { value: "active" } });
    expect(names()).toEqual(["Вода 10", "Молоко 3,2% 0,9 л"]);
    fireEvent.change(filter, { target: { value: "archived" } });
    expect(names()).toEqual(["Айран"]);
    fireEvent.change(filter, { target: { value: "all" } });
    expect(names()).toHaveLength(4);
  });

  it("says nothing was found apart from an empty catalog", async () => {
    await openProducts(session());
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "кефир" } });
    expect(screen.getByText("Ничего не найдено. Измените поиск или отбор.")).toBeTruthy();
    expect(screen.getByText("Найдено: 0 из 4")).toBeTruthy();
  });

  it("says when the catalog is empty", async () => {
    await openProducts(session([]));
    expect(screen.getByText("Товаров пока нет.")).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено. Измените поиск или отбор.")).toBeNull();
  });

  it("pages the list by 25 and goes back to the first page when the search or the filter changes", async () => {
    const many = Array.from({ length: 30 }, (_, n) => ({
      ...MILK,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      name: `Товар ${n + 1}`,
      printName: null,
    }));
    await openProducts(session(many));
    expect(rows()).toHaveLength(25);
    expect(names()[24]).toBe("Товар 25");
    const pager = () => screen.getByRole("navigation", { name: "Страницы списка товаров" });
    const next = () => within(pager()).getByRole("button", { name: "Вперёд" });
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    fireEvent.click(next());
    expect(names()).toEqual(["Товар 26", "Товар 27", "Товар 28", "Товар 29", "Товар 30"]);
    expect(next()).toHaveProperty("disabled", true);
    // A new search starts again from the first page, though both pages stay.
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "Товар" } });
    expect(names()[0]).toBe("Товар 1");
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    // So does a new state filter.
    fireEvent.click(next());
    fireEvent.change(screen.getByLabelText("Состояние"), { target: { value: "active" } });
    expect(names()[0]).toBe("Товар 1");
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    // A search that leaves one page shows it without the pager.
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "Товар 1" } });
    expect(names()).toEqual([
      "Товар 1",
      "Товар 10",
      "Товар 11",
      "Товар 12",
      "Товар 13",
      "Товар 14",
      "Товар 15",
      "Товар 16",
      "Товар 17",
      "Товар 18",
      "Товар 19",
    ]);
    expect(screen.queryByRole("navigation", { name: "Страницы списка товаров" })).toBeNull();
  });

  it("explains a failed load and loads again", async () => {
    const fake = session();
    fake.api.listProducts.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 3,2% 0,9 л")).toBeTruthy();
  });

  it("keeps the list when the product groups do not load, shows their codes and loads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    await openProducts(fake);
    expect(
      await screen.findByText(
        "Справочник товарных групп не загрузился: в списке видны коды групп.",
      ),
    ).toBeTruthy();
    expect(within(rowOf("Молоко 3,2% 0,9 л")).getByText("Код 8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await within(rowOf("Молоко 3,2% 0,9 л")).findByText("Молочная продукция")).toBeTruthy();
  });

  it("reads the product groups once while they are cached, and the products on every visit", async () => {
    const fake = session();
    await openProducts(fake);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(2));
    await screen.findByText("Молоко 3,2% 0,9 л");
    // Two passes of the scheduler: an effect that would read again has run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.api.listProductGroups).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Запустить тест — он падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx`
Expected: FAIL — файл не загружается: `Failed to resolve import "../src/office/products/product-list.js"`.

- [ ] **Step 3: Пункт меню, маршрут и страница**

1. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  lines: ["office", "lines"],
  operators: ["office", "operators"],
  badgeSalt: ["office", "badge-salt"],
} as const;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  lines: ["office", "lines"],
  operators: ["office", "operators"],
  badgeSalt: ["office", "badge-salt"],
  productGroups: ["office", "product-groups"],
  products: ["office", "products"],
} as const;

/**
```

2. Create `apps/standalone/src/office/products/product-queries.ts`:

<!-- prettier-ignore -->
```ts
import { officeKeys, useOfficeQuery } from "../office-query.js";

/**
 * The ЧЗ product groups (`GET /v1/office/product-groups`): a static lookup,
 * so it is not read again while it is cached (`staleTime: Infinity`). The page
 * and the product dialog share it.
 */
export function useProductGroups() {
  return useOfficeQuery(officeKeys.productGroups, (api, token) => api.listProductGroups(token), {
    staleTime: Infinity,
  });
}
```

3. Create `apps/standalone/src/office/products/product-list.ts`:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type { OfficeProduct, ProductGroup } from "../../host/protocol.js";

/** A product as the list names it: archived, or else the host's status. */
export type ProductState = "draft" | "active" | "archived";

export function productState(product: Pick<OfficeProduct, "archived" | "status">): ProductState {
  return product.archived ? "archived" : product.status;
}

/** What the state filter keeps. */
export type ProductFilter = "all" | ProductState;

/** Rows on one page of the list. */
export const PAGE_SIZE = 25;

/**
 * Whether `product` matches the search: its name or print name holds the
 * text, without case, or its GTIN holds the text with its spaces taken out,
 * so «4600 682» finds 04600682000013. A blank search matches every product.
 */
export function matchesSearch(
  product: Pick<OfficeProduct, "name" | "printName" | "gtin14">,
  search: string,
): boolean {
  const text = search.trim().toLocaleLowerCase("ru");
  if (text === "") return true;
  return (
    product.name.toLocaleLowerCase("ru").includes(text) ||
    (product.printName?.toLocaleLowerCase("ru").includes(text) ?? false) ||
    product.gtin14.includes(text.replace(/\s+/g, ""))
  );
}

/** The products the search and the state filter keep, in the order given. */
export function findProducts<T extends OfficeProduct>(
  products: readonly T[],
  search: string,
  filter: ProductFilter,
): T[] {
  return products.filter(
    (product) =>
      (filter === "all" || productState(product) === filter) && matchesSearch(product, search),
  );
}

/**
 * How the office names a product group: its name from the host's lookup;
 * its code when the lookup does not have it or did not load; none.
 */
export function groupLabel(
  groups: readonly ProductGroup[] | undefined,
  code: number | null,
  t: TFunction,
): string {
  if (code === null) return t("office.common.none");
  const group = groups?.find((each) => each.code === code);
  return group === undefined ? t("office.products.unknownGroup", { code }) : group.name;
}
```

4. Create `apps/standalone/src/office/products/ProductsPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import {
  findProducts,
  groupLabel,
  PAGE_SIZE,
  productState,
  type ProductFilter,
  type ProductState,
} from "./product-list.js";
import { useProductGroups } from "./product-queries.js";

/** A state in words and in its phase: archived is out of use, not an alarm. */
const STATE_PHASE = {
  draft: "draft",
  active: "active",
  archived: "retired",
} as const satisfies Record<ProductState, TagPhase>;

const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

interface ProductsPagerProps {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}

/** The list's pages, in the office's words. */
function ProductsPager({ page, pageCount, onPage }: ProductsPagerProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("office.products.pager.label")} className="office-pager">
      <Button
        variant="secondary"
        size="compact"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t("office.products.pager.previous")}
      </Button>
      <span>{t("office.products.pager.page", { page, pages: pageCount })}</span>
      <Button
        variant="secondary"
        size="compact"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t("office.products.pager.next")}
      </Button>
    </nav>
  );
}

/**
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
 * sends the whole list, so the search, the state filter and the pages work
 * here. A product group's name comes from the host's lookup; when it does not
 * load, the list stays and shows the codes.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [page, setPage] = useState(1);

  const columns: TableColumn<OfficeProduct>[] = [
    {
      key: "gtin14",
      title: t("office.products.table.gtin"),
      mono: true,
      render: (product) => product.gtin14,
    },
    {
      key: "name",
      title: t("office.products.table.name"),
      wrap: true,
      render: (product) => (
        <span className="product-name">
          <span>{product.name}</span>
          {product.printName !== null && product.printName !== product.name && (
            <span className="product-name__print">
              {t("office.products.printNameShort", { name: product.printName })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "group",
      title: t("office.products.table.group"),
      wrap: true,
      render: (product) => groupLabel(groups.data, product.chzProductGroupCode, t),
    },
    {
      key: "boxCapacity",
      title: t("office.products.table.boxCapacity"),
      mono: true,
      align: "right",
      render: (product) => product.boxCapacity ?? t("office.common.none"),
    },
    {
      key: "state",
      title: t("office.products.table.state"),
      render: (product) => {
        const state = productState(product);
        return (
          <StatusChip phase={STATE_PHASE[state]} label={t(`office.products.states.${state}`)} />
        );
      },
    },
  ];

  const content = () => {
    if (products.isPending) return <PageLoading />;
    if (products.isError) {
      return <LoadError error={products.error} onRetry={() => void products.refetch()} />;
    }
    const found = findProducts(activeFirstByName(products.data), search, filter);
    const pageCount = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
    // A shorter list (a product archived and filtered out) never shows an empty page.
    const shown = Math.min(page, pageCount);
    return (
      <>
        <FilterBar
          label={t("office.products.filters")}
          resultSummary={t("office.products.found", {
            shown: found.length,
            total: products.data.length,
          })}
        >
          <Input
            label={t("office.products.search")}
            hint={t("office.products.searchHint")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <Select
            native
            label={t("office.products.stateFilter")}
            options={FILTERS.map((value) => ({
              value,
              label: t(`office.products.states.${value}`),
            }))}
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setPage(1);
            }}
          />
        </FilterBar>
        <Card>
          <Table
            columns={columns}
            rows={found.slice((shown - 1) * PAGE_SIZE, shown * PAGE_SIZE)}
            getRowKey={(product) => product.id}
            empty={t(
              products.data.length === 0 ? "office.products.empty" : "office.products.nothingFound",
            )}
            scrollLabel={t("office.products.title")}
          />
          {pageCount > 1 && <ProductsPager page={shown} pageCount={pageCount} onPage={setPage} />}
        </Card>
      </>
    );
  };

  return (
    <>
      <PageHeader title={t("office.products.title")} />
      {groups.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.products.groupsFailed")}
        </Alert>
      )}
      {content()}
    </>
  );
}
```

5. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    roles: ["admin"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
```

заменить на

<!-- prettier-ignore -->
```ts
    roles: ["admin"],
  },
  {
    to: "/products",
    labelKey: "office.nav.products",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
```

6. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { OfficeShell } from "./OfficeShell.js";
import { OperatorsPage } from "./operators/OperatorsPage.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { OfficeShell } from "./OfficeShell.js";
import { OperatorsPage } from "./operators/OperatorsPage.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

7. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          </RequireRole>
        ),
      },
      {
        path: "users",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
          </RequireRole>
        ),
      },
      { path: "products", element: <ProductsPage /> },
      {
        path: "users",
        element: (
```

8. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  color: var(--fg-2);
}

/* An operator's badges: revoked ones stay listed, dimmed, as the record of what was issued. */
.badge-list {
  display: grid;
```

заменить на

<!-- prettier-ignore -->
```css
  color: var(--fg-2);
}

/* A product's name, and its print name on a quieter second line when it differs. */
.product-name {
  display: grid;
}

.product-name__print {
  color: var(--fg-2);
}

.office-pager {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 12px 0 0;
}

/* An operator's badges: revoked ones stay listed, dimmed, as the record of what was issued. */
.badge-list {
  display: grid;
```

9. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "production": "Производство",
        "access": "Доступ"
      },
```

заменить на

<!-- prettier-ignore -->
```json
        "production": "Производство",
        "catalog": "Каталог",
        "access": "Доступ"
      },
```

10. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

заменить на

<!-- prettier-ignore -->
```json
      "devices": "Устройства",
      "products": "Товары",
      "users": "Пользователи"
    },
```

11. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "noAccess": {
      "title": "Нет доступа",
```

заменить на

<!-- prettier-ignore -->
```json
    "products": {
      "title": "Товары",
      "empty": "Товаров пока нет.",
      "nothingFound": "Ничего не найдено. Измените поиск или отбор.",
      "filters": "Поиск и отбор товаров",
      "search": "Поиск",
      "searchHint": "Название, название для печати или GTIN",
      "stateFilter": "Состояние",
      "found": "Найдено: {{shown}} из {{total}}",
      "states": {
        "all": "Все",
        "draft": "Черновик",
        "active": "Активен",
        "archived": "В архиве"
      },
      "table": {
        "gtin": "GTIN",
        "name": "Название",
        "group": "Товарная группа",
        "boxCapacity": "В коробе, шт.",
        "state": "Состояние"
      },
      "printNameShort": "Для печати: {{name}}",
      "unknownGroup": "Код {{code}}",
      "groupsFailed": "Справочник товарных групп не загрузился: в списке видны коды групп.",
      "pager": {
        "label": "Страницы списка товаров",
        "previous": "Назад",
        "next": "Вперёд",
        "page": "Страница {{page}} из {{pages}}"
      }
    },
    "noAccess": {
      "title": "Нет доступа",
```

- [ ] **Step 4: Запустить тест — он проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx`
Expected: PASS — 13 тестов.

Run: то же с `--reporter=verbose` — stderr пуст; затем тот же файл под стендом с задержкой `setImmediate` — PASS, 13.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/office/products/ProductsPage.tsx` показывать товары в порядке хоста: фрагмент

<!-- prettier-ignore -->
```tsx
    const found = findProducts(activeFirstByName(products.data), search, filter);
```

заменить на

<!-- prettier-ignore -->
```tsx
    const found = findProducts(products.data, search, filter);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx -t "lists the products"`
Expected: FAIL — `expected [ 'Вода 10', 'Вода 2', …(2) ] to deeply equal [ 'Вода 2', 'Вода 10', …(2) ]`.

Мутация 2. В `apps/standalone/src/office/products/product-list.ts` искать GTIN с пробелами поиска: фрагмент

<!-- prettier-ignore -->
```ts
    product.gtin14.includes(text.replace(/\s+/g, ""))
```

заменить на

<!-- prettier-ignore -->
```ts
    product.gtin14.includes(text)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx -t "spaces in a GTIN|the way the list does"`
Expected: FAIL — 2 теста: `expected [ undefined ] to deeply equal [ 'Вода 10' ]` и `4600 682: expected false to be true`.

Мутация 3. В `apps/standalone/src/office/products/product-queries.ts` перечитывать справочник групп при каждом показе: фрагмент

<!-- prettier-ignore -->
```ts
  return useOfficeQuery(officeKeys.productGroups, (api, token) => api.listProductGroups(token), {
    staleTime: Infinity,
  });
```

заменить на

<!-- prettier-ignore -->
```ts
  return useOfficeQuery(officeKeys.productGroups, (api, token) => api.listProductGroups(token));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx -t "reads the product groups once"`
Expected: FAIL — `expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 4. В `apps/standalone/src/office/products/ProductsPage.tsx` не возвращаться на первую страницу при новом поиске: фрагмент

<!-- prettier-ignore -->
```tsx
              setSearch(event.target.value);
              setPage(1);
```

заменить на

<!-- prettier-ignore -->
```tsx
              setSearch(event.target.value);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx -t "pages the list"`
Expected: FAIL — `expected 'Товар 26' to be 'Товар 1'`.

Мутация 5. В `apps/standalone/src/office/products/ProductsPage.tsx` не возвращаться на первую страницу при новом отборе: фрагмент

<!-- prettier-ignore -->
```tsx
              setFilter(value);
              setPage(1);
```

заменить на

<!-- prettier-ignore -->
```tsx
              setFilter(value);
```

Run: та же команда, что у мутации 4.
Expected: FAIL — `expected 'Товар 26' to be 'Товар 1'` (после смены отбора).

Мутация 6. В `apps/standalone/src/office/products/ProductsPage.tsx` считать пустым каталог, в котором ничего не нашлось: фрагмент

<!-- prettier-ignore -->
```tsx
              products.data.length === 0 ? "office.products.empty" : "office.products.nothingFound",
```

заменить на

<!-- prettier-ignore -->
```tsx
              found.length === 0 ? "office.products.empty" : "office.products.nothingFound",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/products-page.test.tsx -t "nothing was found"`
Expected: FAIL — `Unable to find an element with the text: Ничего не найдено. Измените поиск или отбор.`

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
what was typed and a save over a newer record meets `stale_revision`. Pages read
fresh data whenever they open (`staleTime` 0), except the site's badge salt,
which never changes and is not read again while it is cached (`staleTime:
Infinity`, see «Office pages»).
```

заменить на

<!-- prettier-ignore -->
```text
what was typed and a save over a newer record meets `stale_revision`. Pages read
fresh data whenever they open (`staleTime` 0), except the site's badge salt and
the ЧЗ product groups, which never change and are not read again while they are
cached (`staleTime: Infinity`, see «Office pages»).
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
- Lists of archivable records (counterparties, lines) show active records
  before archived ones, each by name in Russian order with numbers by value
  (`activeFirstByName` in `src/office/records.tsx`, with
  `Intl.Collator("ru", { numeric: true })`); the host sorts bytewise, which
  puts «Линия 10» before «Линия 2».
```

заменить на

<!-- prettier-ignore -->
```text
- Lists of archivable records (counterparties, lines, products) show active
  records before archived ones, each by name in Russian order with numbers by
  value (`activeFirstByName` in `src/office/records.tsx`, with
  `Intl.Collator("ru", { numeric: true })`); the host sorts bytewise, which
  puts «Линия 10» before «Линия 2».
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  the time, so no host timestamp is compared with this PC's clock, and join
  detection compares host timestamps only.

## Marking rules
```

заменить на

<!-- prettier-ignore -->
```text
  the time, so no host timestamp is compared with this PC's clock, and join
  detection compares host timestamps only.
- «Товары» (section «Каталог») lists every product, archived ones included,
  and every role reads it: active ones before archived ones, each by name
  (`activeFirstByName`), with the GTIN, the print name as a second line when
  it differs from the name, the product group's name from
  `GET /v1/office/product-groups` (its code when the lookup lacks it or did
  not load; a failed lookup leaves the list in place and offers to read it
  again), the box capacity and the state in words (draft, active, archived).
  The host sends the whole list, so the search (name, print name or GTIN,
  without case, a GTIN's spaces ignored), the state filter and the pages of
  25 work in the page, and a new search or filter goes back to the first
  page. The groups are a static lookup, not read again while cached
  (`staleTime: Infinity`).

## Marking rules
```

4. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  `@markiro/domain` и отправляет только хеши.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
```

заменить на

<!-- prettier-ignore -->
```text
  `@markiro/domain` и отправляет только хеши.
- Товары (план 1e2): список видят все роли — все товары, архивные тоже, сначала
  действующие, внутри — по названию с числами по значению; GTIN, название для
  печати второй строкой, если оно другое, товарная группа по названию из
  справочника (код, если справочник не загрузился или кода в нём нет),
  вместимость короба и состояние словом. Поиск по названию, названию для печати
  и GTIN, отбор по состоянию и страницы по 25 — в самом экране: хост отдаёт
  список целиком.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
```

Перечитать разделы «App shell» и «Office pages» в `AGENTS.md` и §5.5 спецификации целиком: то, что сказано о «Товарах», совпадает с тем, что делает страница (без кнопок записи до задачи 5).

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/office/products/product-list.ts apps/standalone/src/office/products/product-queries.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/products-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -nF '\u0' apps/standalone/src/i18n/ru.json`
Expected: чисто; первый `grep` находит только `src/host/pairing-code.ts:66`, второй — ничего.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 39 файлов, 914 тестов (901 + 13).

```bash
git add apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/office/products/product-list.ts apps/standalone/src/office/products/product-queries.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/products-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): страница «Товары» — раздел «Каталог», список, поиск, отбор и страницы" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Диалог товара — добавление, правка, архив, подсказки о GTIN

Один `FormDialog` на добавление и правку, по образцу контрагентов: правка шлёт запись целиком с ревизией открытой записи, архив — флажок «В архиве» в том же диалоге (только у правки), удаления нет. Поля: GTIN, название, название для печати, товарная группа (необязательный выбор), в коробе, коробов на паллете, срок годности. GTIN можно менять и при правке; правила полей — задачи 1. Когда GTIN верен, диалог показывает 14 цифр, которыми он сохранится, если они отличаются от набранного, и чей у него префикс — организации, контрагента (действующие первыми, по названию; первый совпавший) или ничей; подсказка не мешает сохранить и пропадает, если организация или контрагенты не загрузились. Строка «Без группы и вместимостей товар остаётся черновиком» видна, пока у формы нет группы или одной из вместимостей.

Группы в выборе — по названию; собственная группа товара остаётся выбором, даже когда справочник её не знает («Код 99 — нет в справочнике») или не загрузился — тогда выбор выключен с подсказкой, и группа уходит без изменений. Отказы хоста (`writeFailure`): поля `validation_failed` — под своим полем, `conflict` `gtin14` — под GTIN (при добавлении, смене GTIN и возврате из архива: пользователь меняет GTIN в том же диалоге и сохраняет снова), `stale_revision` — «Загрузить заново». Сохранённая запись хоста заменяет строку в кэше на месте (`useStoreRecord`), новая добавляется; уведомление называет добавленный товар.

Кнопки записи закрыты `useCan("editCatalog")` (D10): обе роли видят «Добавить товар» и «Изменить» — это проверяет тест, а мутация «закрыть по `editReference`» его роняет. Шаблоны по умолчанию в этой задаче уходят такими, какими пришли с товаром; их выбор — задача 6.

**Files:**

- Create: `apps/standalone/src/office/products/ProductDialog.tsx`, `apps/standalone/src/office/products/product-form.ts`
- Modify: `apps/standalone/src/office/products/ProductsPage.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/product-dialog.test.tsx` (Create)
- Modify: `apps/standalone/AGENTS.md` («Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `gtinRule`, `toGtin14`, `productNameRule`, `printNameRule`, `productGroupRule`, `toGroupCode`, `boxCapacityRule`, `palletBoxCapacityRule`, `shelfLifeDaysRule`, `toCount`, `toOptionalText` — `src/lib/rules.ts` (задача 1);
  - `productCreate`, `productUpdate`, `type ProductInput` — `src/host/requests.ts`; `HostApi.createProduct`, `updateProduct`, `getOrg`, `listCounterparties`; `type OfficeProduct`, `type CounterpartyRecord` (задача 2);
  - `useProductGroups()`, `ProductsPage` (задача 4); `useCan` — `src/office/access.ts`; `useStoreRecord`, `activeFirstByName` — `src/office/records.tsx`; `FormDialog` — `src/office/FormDialog.tsx`; `useFieldError`, `writeFailure`, `type AlertFailure` — `src/office/form-errors.ts`; `WriteFailureAlert` — `src/office/page-state.tsx`; `useOfficeMutation`, `officeKeys.org`, `officeKeys.counterparties` — `src/office/office-query.ts`; `gtinMatchesPrefix` — `@markiro/domain`;
  - `fakeOfficeSession`, `renderOffice`, `TECHNOLOGIST` — `test/support/office.tsx`.
- Produces (`src/office/products/product-form.ts`):
  - `productFieldsSchema`, `type ProductFields` (текст как набран; группа и два шаблона — значения выбора, `""` — нет; `archived`);
  - `PRODUCT_FIELDS`, `PRODUCT_CONFLICTS` (`gtin14` → поле `gtin14`, `office.products.errors.gtinTaken`);
  - `productFields(product: OfficeProduct | null): ProductFields`, `toProductInput(values: ProductFields): ProductInput`, `staysDraft(values): boolean`;
  - `type GtinOwner = { kind: "own" } | { kind: "counterparty"; counterparty: CounterpartyRecord } | { kind: "unknown" }`, `gtinOwner(gtin14: string, orgPrefixes: readonly string[], counterparties: readonly CounterpartyRecord[]): GtinOwner`.
- Produces (`src/office/products/ProductDialog.tsx`):
  - `interface ProductDialogProps { product: OfficeProduct | null; onClose: () => void; onSaved: (product: OfficeProduct) => void; onReload: () => void }`, `ProductDialog(props)`;
  - кнопки «Добавить товар» и «Изменить» (`aria-label` «Изменить товар «…»») на странице; ключи `office.products.add`, `edit`, `editNamed`, `createTitle`, `create`, `editTitle`, `fields.*`, `gtinSavedAs`, `owner.*`, `draftHint`, `groupMissing`, `groupsUnavailable`, `created`, `errors.gtinTaken`, `table.actions`.

- [ ] **Step 1: Тест (падающий)**

1. Create `apps/standalone/test/product-dialog.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { CounterpartyRecord, OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import { gtinOwner } from "../src/office/products/product-form.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 8, alias: "milk", name: "Молочная продукция" },
];

const NORTH: CounterpartyRecord = {
  id: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  name: "ООО «Северный берег»",
  inn: "7812345678",
  gln: "4601234000017",
  gs1Prefixes: ["4601234"],
  archived: false,
  rev: 12,
};
const OLD: CounterpartyRecord = {
  id: "5c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Альфа",
  inn: null,
  gln: "4602222000026",
  gs1Prefixes: ["4602222"],
  archived: true,
  rev: 7,
};

const MILK_58 = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: MILK_58,
  defaultPalletTemplateId: null,
  archived: false,
  status: "active",
  rev: 65,
};
/** Archived: its GTIN is free, and another product may hold it now. */
const AYRAN: OfficeProduct = {
  ...MILK,
  id: "4d5e6f70-8192-4a34-9c5d-6e7f80910213",
  gtin14: "04605555000015",
  name: "Айран",
  printName: null,
  defaultBoxTemplateId: null,
  archived: true,
  rev: 72,
};

function session(user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.listProducts.mockResolvedValue([MILK, AYRAN]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([NORTH, OLD]);
  return fake;
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

async function openProducts(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
  await screen.findByText("Молоко 3,2% 0,9 л");
}

/** Opens «Добавить товар» and waits for the lists the dialog reads. */
async function openCreate(fake: FakeOfficeSession): Promise<void> {
  await openProducts(fake);
  fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Товарная группа")).toHaveProperty("disabled", false),
  );
}

function hostError(code: string, status: number, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

const VALIDATION = (field: string) => hostError("validation_failed", 400, { field });

describe("office product dialog", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lets both office roles add and change products", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(user));
      fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
      expect(
        await screen.findByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Добавить товар" })).toBeTruthy();
      view.unmount();
    }
  });

  it("adds a product, sending the GTIN as its 14 digits and every field by name", async () => {
    const fake = session();
    const created: OfficeProduct = {
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      name: "Молоко 2,5% 1 л",
      printName: null,
      defaultBoxTemplateId: null,
      rev: 80,
    };
    fake.api.createProduct.mockResolvedValue(created);
    await openCreate(fake);
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    type("GTIN", " 4600682000013 ");
    type("Название", " Молоко 2,5% 1 л ");
    type("Название для печати", "   ");
    type("Товарная группа", "8");
    type("В коробе, шт.", "12");
    type("Коробов на паллете", "40");
    type("Срок годности, дней", " 10 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Товар «Молоко 2,5% 1 л» добавлен.")).toBeTruthy();
    expect(fake.api.createProduct.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          gtin14: "04600682000013",
          name: "Молоко 2,5% 1 л",
          printName: null,
          chzProductGroupCode: 8,
          boxCapacity: 12,
          palletBoxCapacity: 40,
          shelfLifeDays: 10,
          defaultBoxTemplateId: null,
          defaultPalletTemplateId: null,
        },
      ],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Молоко 2,5% 1 л")).toBeTruthy();
  });

  it("checks the fields like the host, and a GTIN's check digit, before sending", async () => {
    const fake = session();
    await openCreate(fake);
    type("GTIN", "4600682000010");
    type("Название", "  ");
    type("Название для печати", "я".repeat(201));
    type("В коробе, шт.", "0");
    type("Коробов на паллете", "1e3");
    type("Срок годности, дней", "3651");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Неверная контрольная цифра GTIN")).toBeTruthy();
    expect(screen.getByText("Укажите название товара, до 200 символов")).toBeTruthy();
    expect(screen.getByText("Название для печати — до 200 символов")).toBeTruthy();
    expect(
      screen.getByText("Укажите целое число от 1 до 100 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 10 000 или оставьте пустым")).toBeTruthy();
    expect(
      screen.getByText("Укажите целое число дней от 1 до 3650 или оставьте пустым"),
    ).toBeTruthy();
    expect(fake.api.createProduct).not.toHaveBeenCalled();
  });

  it("says a GTIN of a wrong length in its own words", async () => {
    await openCreate(session());
    type("GTIN", "46006820000");
    type("Название", "Молоко");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("GTIN — 8, 12, 13 или 14 цифр")).toBeTruthy();
  });

  it("shows the 14 digits a valid GTIN is saved as when they differ from what was typed", async () => {
    await openCreate(session());
    type("GTIN", "4600682000013");
    expect(await screen.findByText("Сохранится как 04600682000013.")).toBeTruthy();
    type("GTIN", "04600682000013");
    await waitFor(() => expect(screen.queryByText(/^Сохранится как/)).toBeNull());
    type("GTIN", "4600682000010");
    await waitFor(() => expect(screen.queryByText(/^Префикс GTIN/)).toBeNull());
  });

  it("says whose prefix a valid GTIN has: the organization's, a counterparty's or nobody's", async () => {
    await openCreate(session());
    type("GTIN", "4600682000013");
    expect(await screen.findByText("Префикс GTIN — вашей организации.")).toBeTruthy();
    type("GTIN", "4601234000017");
    expect(
      await screen.findByText("Префикс GTIN — контрагента «ООО «Северный берег»»."),
    ).toBeTruthy();
    type("GTIN", "4602222000026");
    expect(await screen.findByText("Префикс GTIN — контрагента «Альфа (в архиве)».")).toBeTruthy();
    type("GTIN", "4607091000009");
    expect(
      await screen.findByText(
        "Владелец GTIN не определён: префикс не совпал ни с организацией, ни с контрагентами.",
      ),
    ).toBeTruthy();
  });

  it("finds a GTIN's owner the cloud's way: the organization first, then active counterparties by name", () => {
    const second = { ...NORTH, id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", name: "Альфа-2" };
    expect(gtinOwner("04601234000017", ["4600682"], [NORTH, second])).toEqual({
      kind: "counterparty",
      counterparty: second,
    });
    expect(gtinOwner("04601234000017", ["4601234"], [NORTH])).toEqual({ kind: "own" });
    expect(gtinOwner("04601234000017", [], [{ ...second, archived: true }, NORTH])).toEqual({
      kind: "counterparty",
      counterparty: NORTH,
    });
    expect(gtinOwner("04607091000009", ["4600682"], [NORTH, OLD])).toEqual({ kind: "unknown" });
  });

  it("leaves the owner out when the organization or the counterparties do not load, and still saves", async () => {
    const fake = session();
    fake.api.getOrg.mockRejectedValue(hostError("internal", 500));
    fake.api.createProduct.mockResolvedValue({
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    });
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    expect(await screen.findByText("Сохранится как 04600682000013.")).toBeTruthy();
    expect(screen.queryByText(/^Префикс GTIN|^Владелец GTIN/)).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(fake.api.createProduct).toHaveBeenCalledTimes(1));
  });

  it("says a product without a group or both capacities stays a draft", async () => {
    await openCreate(session());
    const hint = "Без группы и вместимостей товар остаётся черновиком.";
    expect(screen.getByText(hint)).toBeTruthy();
    type("Товарная группа", "8");
    type("В коробе, шт.", "12");
    expect(screen.getByText(hint)).toBeTruthy();
    type("Коробов на паллете", "40");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
  });

  it("saves a change as the whole record with the loaded revision, archive included", async () => {
    const fake = session();
    fake.api.updateProduct.mockResolvedValue({
      ...MILK,
      name: "Молоко 3,2% 1 л",
      archived: true,
      rev: 81,
    });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateProduct.mock.calls).toStrictEqual([
      [
        "office-session-token",
        MILK.id,
        {
          gtin14: "04600682000013",
          name: "Молоко 3,2% 1 л",
          printName: "Молоко 3,2%",
          chzProductGroupCode: 8,
          boxCapacity: 12,
          palletBoxCapacity: 40,
          shelfLifeDays: 10,
          defaultBoxTemplateId: MILK_58,
          defaultPalletTemplateId: null,
          archived: true,
          expectedRev: 65,
        },
      ],
    ]);
    // The record the host returned took the old row's place, and sorts as archived now.
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[1]?.textContent)).toEqual([
      "Айран",
      "Молоко 3,2% 1 лДля печати: Молоко 3,2%",
    ]);
  });

  it("puts a taken GTIN under the GTIN when a product comes back from the archive, and saves it under another", async () => {
    const fake = session();
    fake.api.updateProduct
      .mockRejectedValueOnce(hostError("conflict", 409, { constraint: "gtin14" }))
      .mockResolvedValueOnce({ ...AYRAN, gtin14: "04607091000009", archived: false, rev: 82 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Айран»" }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    const message = await screen.findByText("Этот GTIN уже у товара в работе");
    expect(screen.getByLabelText("GTIN").getAttribute("aria-describedby")).toBe(message.id);
    type("GTIN", "4607091000009");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(
      fake.api.updateProduct.mock.calls.map((call) => [call[2].gtin14, call[2].archived]),
    ).toEqual([
      ["04605555000015", false],
      ["04607091000009", false],
    ]);
  });

  it("puts the host's refusal of a field under that field", async () => {
    const fake = session();
    fake.api.createProduct.mockRejectedValueOnce(VALIDATION("shelfLifeDays"));
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    type("Срок годности, дней", "10");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.getByLabelText("Срок годности, дней").getAttribute("aria-describedby")).toBe(
      message.id,
    );
  });

  it("offers to load the products again after a stale change", async () => {
    const fake = session();
    fake.api.updateProduct.mockRejectedValueOnce(
      hostError("stale_revision", 409, { currentRev: 66 }),
    );
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(2));
  });

  it("sends one request for a double click, and none while it is on its way", async () => {
    const fake = session();
    let answer: (product: OfficeProduct) => void = () => undefined;
    fake.api.createProduct.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко 2,5% 1 л");
    const add = within(dialog()).getByRole("button", { name: "Добавить" });
    // Both clicks in one `act`: nothing renders between them, so the button is
    // not yet disabled for the second, and only the dialog's own guard drops it.
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await waitFor(() => expect(add).toHaveProperty("disabled", true));
    fireEvent.click(add);
    expect(fake.api.createProduct).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ ...MILK, id: "0f1e2d3c-4b5a-4968-8776-655443322110", name: "Молоко 2,5% 1 л" });
    });
    expect(await screen.findByText("Товар «Молоко 2,5% 1 л» добавлен.")).toBeTruthy();
    expect(fake.api.createProduct).toHaveBeenCalledTimes(1);
  });

  it("offers the groups by name and keeps a product's group the lookup lacks", async () => {
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, chzProductGroupCode: 99 }]);
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    const select = screen.getByLabelText("Товарная группа");
    await waitFor(() => expect(select).toHaveProperty("disabled", false));
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Без группы",
      "Молочная продукция",
      "Упакованная вода",
      "Код 99 — нет в справочнике",
    ]);
    expect(select).toHaveProperty("value", "99");
  });

  it("keeps the product's group when the lookup does not load, and sends it unchanged", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValue(hostError("internal", 500));
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко 3,2% 1 л", rev: 81 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(
      await screen.findByText("Справочник групп не загрузился: группу сейчас не изменить."),
    ).toBeTruthy();
    const select = screen.getByLabelText("Товарная группа");
    expect(select).toHaveProperty("disabled", true);
    expect(select).toHaveProperty("value", "8");
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2].chzProductGroupCode).toBe(8);
  });
});
```

- [ ] **Step 2: Запустить тест — он падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx`
Expected: FAIL — файл не загружается: `Failed to resolve import "../src/office/products/product-form.js"`.

- [ ] **Step 3: Форма, диалог и кнопки страницы**

1. Create `apps/standalone/src/office/products/product-form.ts`:

<!-- prettier-ignore -->
```ts
import { gtinMatchesPrefix } from "@markiro/domain";
import { z } from "zod";

import type { CounterpartyRecord, OfficeProduct } from "../../host/protocol.js";
import type { ProductInput } from "../../host/requests.js";
import {
  boxCapacityRule,
  gtinRule,
  palletBoxCapacityRule,
  printNameRule,
  productGroupRule,
  productNameRule,
  shelfLifeDaysRule,
  toCount,
  toGroupCode,
  toGtin14,
  toOptionalText,
} from "../../lib/rules.js";
import { activeFirstByName } from "../records.js";

/**
 * A product as the form holds it: text as typed, and the group and the two
 * templates as their selects hold them (`""` for none).
 */
export const productFieldsSchema = z.object({
  gtin14: gtinRule,
  name: productNameRule,
  printName: printNameRule,
  chzProductGroupCode: productGroupRule,
  boxCapacity: boxCapacityRule,
  palletBoxCapacity: palletBoxCapacityRule,
  shelfLifeDays: shelfLifeDaysRule,
  defaultBoxTemplateId: z.string(),
  defaultPalletTemplateId: z.string(),
  archived: z.boolean(),
});
export type ProductFields = z.input<typeof productFieldsSchema>;

/** The host names a product's fields as the form does (`routes/products.rs`). */
export const PRODUCT_FIELDS = {
  gtin14: "gtin14",
  name: "name",
  printName: "printName",
  chzProductGroupCode: "chzProductGroupCode",
  boxCapacity: "boxCapacity",
  palletBoxCapacity: "palletBoxCapacity",
  shelfLifeDays: "shelfLifeDays",
} as const;

/** Another product in use has the GTIN (`products_active_gtin14`). */
export const PRODUCT_CONFLICTS = {
  gtin14: { field: "gtin14", message: "office.products.errors.gtinTaken" },
} as const;

/** A number as the form holds it: blank for none. */
function numberText(value: number | null): string {
  return value === null ? "" : String(value);
}

/** The form's values for a product, or empty ones for a new product. */
export function productFields(product: OfficeProduct | null): ProductFields {
  return {
    gtin14: product?.gtin14 ?? "",
    name: product?.name ?? "",
    printName: product?.printName ?? "",
    chzProductGroupCode: numberText(product?.chzProductGroupCode ?? null),
    boxCapacity: numberText(product?.boxCapacity ?? null),
    palletBoxCapacity: numberText(product?.palletBoxCapacity ?? null),
    shelfLifeDays: numberText(product?.shelfLifeDays ?? null),
    defaultBoxTemplateId: product?.defaultBoxTemplateId ?? "",
    defaultPalletTemplateId: product?.defaultPalletTemplateId ?? "",
    archived: product?.archived ?? false,
  };
}

/**
 * The host's product fields for values the form accepted: trimmed, the GTIN
 * as its 14 digits, `null` for a field left blank.
 */
export function toProductInput(values: ProductFields): ProductInput {
  return {
    gtin14: toGtin14(values.gtin14),
    name: values.name.trim(),
    printName: toOptionalText(values.printName),
    chzProductGroupCode: toGroupCode(values.chzProductGroupCode),
    boxCapacity: toCount(values.boxCapacity),
    palletBoxCapacity: toCount(values.palletBoxCapacity),
    shelfLifeDays: toCount(values.shelfLifeDays),
    defaultBoxTemplateId: values.defaultBoxTemplateId === "" ? null : values.defaultBoxTemplateId,
    defaultPalletTemplateId:
      values.defaultPalletTemplateId === "" ? null : values.defaultPalletTemplateId,
  };
}

/**
 * Whether a product with these values stays a draft: the host makes it
 * `active` only with a product group and both capacities.
 */
export function staysDraft(
  values: Pick<ProductFields, "chzProductGroupCode" | "boxCapacity" | "palletBoxCapacity">,
): boolean {
  return (
    values.chzProductGroupCode === "" ||
    values.boxCapacity.trim() === "" ||
    values.palletBoxCapacity.trim() === ""
  );
}

/** Whose GS1 prefix a GTIN has. */
export type GtinOwner =
  | { kind: "own" }
  | { kind: "counterparty"; counterparty: CounterpartyRecord }
  | { kind: "unknown" };

/**
 * Whose prefix a GTIN of 14 digits has, as the cloud's `checkGtinOwner`
 * answers it: the organization's when one of its GS1 prefixes matches
 * (`gtinMatchesPrefix`), else the first counterparty's that matches, active
 * ones first, by name, else nobody's. It informs and never blocks a save.
 */
export function gtinOwner(
  gtin14: string,
  orgPrefixes: readonly string[],
  counterparties: readonly CounterpartyRecord[],
): GtinOwner {
  if (orgPrefixes.some((prefix) => gtinMatchesPrefix(gtin14, prefix))) return { kind: "own" };
  const counterparty = activeFirstByName(counterparties).find((each) =>
    each.gs1Prefixes.some((prefix) => gtinMatchesPrefix(gtin14, prefix)),
  );
  return counterparty === undefined ? { kind: "unknown" } : { kind: "counterparty", counterparty };
}
```

2. Create `apps/standalone/src/office/products/ProductDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, Input, Select } from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, toGtin14 } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  gtinOwner,
  PRODUCT_CONFLICTS,
  PRODUCT_FIELDS,
  productFields,
  productFieldsSchema,
  staysDraft,
  toProductInput,
  type GtinOwner,
  type ProductFields,
} from "./product-form.js";
import { useProductGroups } from "./product-queries.js";

/** Group names in Russian order, with numbers by value. */
const GROUP_NAMES = new Intl.Collator("ru", { numeric: true });

/** What a save sends: the product's fields, and for an edit its `archived` flag. */
interface ProductWrite {
  input: ProductInput;
  archived: boolean;
}

export interface ProductDialogProps {
  /** `null` adds a product. */
  product: OfficeProduct | null;
  onClose: () => void;
  onSaved: (product: OfficeProduct) => void;
  /** The product changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Adds a product, or changes one: the host takes the whole record with the
 * loaded revision, and archiving is its `archived` flag (no delete). The GTIN
 * may change too. Once it is valid, the dialog shows the 14 digits it is saved
 * as and whose GS1 prefix it has; neither blocks a save.
 */
export function ProductDialog({ product, onClose, onSaved, onReload }: ProductDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const groups = useProductGroups();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const save = useOfficeMutation((api, token, { input, archived }: ProductWrite) =>
    product === null
      ? api.createProduct(token, productCreate(input))
      : api.updateProduct(token, product.id, productUpdate(input, archived, product.rev)),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isDirty },
  } = useForm<ProductFields>({
    resolver: zodResolver(productFieldsSchema),
    defaultValues: productFields(product),
  });
  const [typedGtin, group, boxCapacity, palletBoxCapacity] = watch([
    "gtin14",
    "chzProductGroupCode",
    "boxCapacity",
    "palletBoxCapacity",
  ]);

  const gtin = gtinRule.safeParse(typedGtin);
  const gtin14 = gtin.success ? toGtin14(gtin.data) : null;
  // Absent while either list loads or when one did not load.
  const owner =
    gtin14 !== null && org.isSuccess && counterparties.isSuccess
      ? gtinOwner(gtin14, org.data.gs1Prefixes, counterparties.data)
      : null;
  const ownerText = (found: GtinOwner) => {
    switch (found.kind) {
      case "own":
        return t("office.products.owner.own");
      case "counterparty": {
        const { name, archived } = found.counterparty;
        return t("office.products.owner.counterparty", {
          name: archived ? t("office.common.archivedName", { name }) : name,
        });
      }
      case "unknown":
        return t("office.products.owner.unknown");
    }
  };

  const groupOptions: { value: string; label: string }[] = [
    { value: "", label: t("office.products.fields.noGroup") },
    ...[...(groups.data ?? [])]
      .sort((a, b) => GROUP_NAMES.compare(a.name, b.name))
      .map((each) => ({ value: String(each.code), label: each.name })),
  ];
  // The product's own group stays a choice when the lookup lacks it or did not load.
  const ownGroup = product?.chzProductGroupCode ?? null;
  if (ownGroup !== null && !groupOptions.some((option) => option.value === String(ownGroup))) {
    groupOptions.push({
      value: String(ownGroup),
      label: groups.isSuccess
        ? t("office.products.groupMissing", { code: ownGroup })
        : t("office.products.unknownGroup", { code: ownGroup }),
    });
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const write: ProductWrite = { input: toProductInput(values), archived: values.archived };
    let saved: OfficeProduct;
    try {
      saved = await save.mutateAsync(write);
    } catch (error) {
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={
        product === null
          ? t("office.products.createTitle")
          : t("office.products.editTitle", { name: product.name })
      }
      submitLabel={product === null ? t("office.products.create") : t("office.common.save")}
      submitDisabled={product !== null && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <div className="product-gtin">
        <Input
          label={t("office.products.fields.gtin")}
          hint={t("office.products.fields.gtinHint")}
          inputMode="numeric"
          mono
          {...fieldError(errors.gtin14?.message)}
          {...register("gtin14")}
        />
        <div className="product-gtin__notes" aria-live="polite">
          {gtin14 !== null && gtin14 !== typedGtin.trim() && (
            <p className="office-note">{t("office.products.gtinSavedAs", { gtin14 })}</p>
          )}
          {owner !== null && <p className="office-note">{ownerText(owner)}</p>}
        </div>
      </div>
      <Input
        label={t("office.products.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("office.products.fields.printName")}
        hint={t("office.products.fields.printNameHint")}
        {...fieldError(errors.printName?.message)}
        {...register("printName")}
      />
      <Controller
        control={control}
        name="chzProductGroupCode"
        render={({ field }) => (
          <Select
            native
            label={t("office.products.fields.group")}
            options={groupOptions}
            value={field.value}
            onValueChange={field.onChange}
            disabled={!groups.isSuccess}
            {...(groups.isError ? { hint: t("office.products.groupsUnavailable") } : {})}
            {...fieldError(errors.chzProductGroupCode?.message)}
          />
        )}
      />
      <Input
        label={t("office.products.fields.boxCapacity")}
        hint={t("office.products.fields.optional")}
        inputMode="numeric"
        mono
        {...fieldError(errors.boxCapacity?.message)}
        {...register("boxCapacity")}
      />
      <Input
        label={t("office.products.fields.palletBoxCapacity")}
        hint={t("office.products.fields.palletBoxCapacityHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.palletBoxCapacity?.message)}
        {...register("palletBoxCapacity")}
      />
      {staysDraft({ chzProductGroupCode: group, boxCapacity, palletBoxCapacity }) && (
        <p className="office-note">{t("office.products.draftHint")}</p>
      )}
      <Input
        label={t("office.products.fields.shelfLifeDays")}
        hint={t("office.products.fields.optional")}
        inputMode="numeric"
        mono
        {...fieldError(errors.shelfLifeDays?.message)}
        {...register("shelfLifeDays")}
      />
      {product !== null && (
        <Controller
          control={control}
          name="archived"
          render={({ field }) => (
            <Checkbox
              label={t("office.products.fields.archived")}
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

3. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
} from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import {
  findProducts,
  groupLabel,
```

заменить на

<!-- prettier-ignore -->
```tsx
} from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, useStoreRecord } from "../records.js";
import { ProductDialog } from "./ProductDialog.js";
import {
  findProducts,
  groupLabel,
```

4. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
} as const satisfies Record<ProductState, TagPhase>;

const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

interface ProductsPagerProps {
  page: number;
```

заменить на

<!-- prettier-ignore -->
```tsx
} as const satisfies Record<ProductState, TagPhase>;

const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

type ProductsDialog = { kind: "create" } | { kind: "edit"; product: OfficeProduct };

interface ProductsPagerProps {
  page: number;
```

5. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
 * sends the whole list, so the search, the state filter and the pages work
 * here. A product group's name comes from the host's lookup; when it does not
 * load, the list stays and shows the codes.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [page, setPage] = useState(1);

  const columns: TableColumn<OfficeProduct>[] = [
    {
```

заменить на

<!-- prettier-ignore -->
```tsx
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
 * sends the whole list, so the search, the state filter and the pages work
 * here. A product group's name comes from the host's lookup; when it does not
 * load, the list stays and shows the codes. Both office roles add and change
 * products (`editCatalog`); there is no delete, a product is archived instead.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const groups = useProductGroups();
  const store = useStoreRecord<OfficeProduct>(officeKeys.products);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<ProductsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: ProductsDialog) => {
    setNotice(null);
    setDialog(next);
  };

  const columns: TableColumn<OfficeProduct>[] = [
    {
```

6. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      },
    },
  ];

  const content = () => {
    if (products.isPending) return <PageLoading />;
```

заменить на

<!-- prettier-ignore -->
```tsx
      },
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.products.table.actions"),
      render: (product) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.products.editNamed", { name: product.name })}
          onClick={() => open({ kind: "edit", product })}
        >
          {t("office.products.edit")}
        </Button>
      ),
    });
  }

  const content = () => {
    if (products.isPending) return <PageLoading />;
```

7. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  };

  return (
    <>
      <PageHeader title={t("office.products.title")} />
      {groups.isError && (
        <Alert
          tone="warn"
          action={
```

заменить на

<!-- prettier-ignore -->
```tsx
  };

  return (
    <>
      <PageHeader
        title={t("office.products.title")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.products.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {groups.isError && (
        <Alert
          tone="warn"
          action={
```

8. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        </Alert>
      )}
      {content()}
    </>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
        </Alert>
      )}
      {content()}
      {canEdit && dialog !== null && (
        <ProductDialog
          product={dialog.kind === "edit" ? dialog.product : null}
          onClose={() => setDialog(null)}
          onSaved={(product) => {
            store(product);
            setDialog(null);
            setNotice(
              dialog.kind === "create"
                ? t("office.products.created", { name: product.name })
                : t("office.common.saved"),
            );
          }}
          onReload={() => {
            setDialog(null);
            void products.refetch();
          }}
        />
      )}
    </>
  );
}
```

9. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  padding: 12px 0 0;
}

/* An operator's badges: revoked ones stay listed, dimmed, as the record of what was issued. */
.badge-list {
  display: grid;
```

заменить на

<!-- prettier-ignore -->
```css
  padding: 12px 0 0;
}

/* The GTIN field, and under it what the dialog says about a valid GTIN. */
.product-gtin,
.product-gtin__notes {
  display: grid;
  gap: 4px;
}

/* An operator's badges: revoked ones stay listed, dimmed, as the record of what was issued. */
.badge-list {
  display: grid;
```

10. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "boxCapacity": "В коробе, шт.",
        "state": "Состояние"
      },
      "printNameShort": "Для печати: {{name}}",
      "unknownGroup": "Код {{code}}",
      "groupsFailed": "Справочник товарных групп не загрузился: в списке видны коды групп.",
```

заменить на

<!-- prettier-ignore -->
```json
        "boxCapacity": "В коробе, шт.",
        "state": "Состояние",
        "actions": "Действия"
      },
      "printNameShort": "Для печати: {{name}}",
      "unknownGroup": "Код {{code}}",
      "groupsFailed": "Справочник товарных групп не загрузился: в списке видны коды групп.",
      "add": "Добавить товар",
      "edit": "Изменить",
      "editNamed": "Изменить товар «{{name}}»",
      "createTitle": "Новый товар",
      "create": "Добавить",
      "editTitle": "Товар «{{name}}»",
      "fields": {
        "gtin": "GTIN",
        "gtinHint": "8, 12, 13 или 14 цифр",
        "name": "Название",
        "printName": "Название для печати",
        "printNameHint": "Необязательно: короткое название для этикетки",
        "group": "Товарная группа",
        "noGroup": "Без группы",
        "boxCapacity": "В коробе, шт.",
        "palletBoxCapacity": "Коробов на паллете",
        "palletBoxCapacityHint": "Необязательно; число коробов, а не штук",
        "shelfLifeDays": "Срок годности, дней",
        "optional": "Необязательно",
        "archived": "В архиве"
      },
      "gtinSavedAs": "Сохранится как {{gtin14}}.",
      "owner": {
        "own": "Префикс GTIN — вашей организации.",
        "counterparty": "Префикс GTIN — контрагента «{{name}}».",
        "unknown": "Владелец GTIN не определён: префикс не совпал ни с организацией, ни с контрагентами."
      },
      "draftHint": "Без группы и вместимостей товар остаётся черновиком.",
      "groupMissing": "Код {{code}} — нет в справочнике",
      "groupsUnavailable": "Справочник групп не загрузился: группу сейчас не изменить.",
      "created": "Товар «{{name}}» добавлен.",
      "errors": {
        "gtinTaken": "Этот GTIN уже у товара в работе"
      },
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx test/products-page.test.tsx`
Expected: PASS — 29 тестов (16 и 13).

Run: то же с `--reporter=verbose` — stderr пуст; затем те же файлы под стендом с задержкой `setImmediate` — PASS, 29.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/office/products/ProductsPage.tsx` закрыть запись правом справочников (D10): фрагмент

<!-- prettier-ignore -->
```tsx
  const canEdit = useCan("editCatalog");
```

заменить на

<!-- prettier-ignore -->
```tsx
  const canEdit = useCan("editReference");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "both office roles"`
Expected: FAIL — `Unable to find role="button" and name "Изменить товар «Молоко 3,2% 0,9 л»"`.

Мутация 2. В `apps/standalone/src/office/products/product-form.ts` слать GTIN как набран: фрагмент

<!-- prettier-ignore -->
```ts
    gtin14: toGtin14(values.gtin14),
```

заменить на

<!-- prettier-ignore -->
```ts
    gtin14: values.gtin14.trim(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "adds a product"`
Expected: FAIL — `expected [ Array(1) ] to strictly equal [ Array(1) ]`: ушло `"gtin14": "4600682000013"`.

Мутация 3. В `apps/standalone/src/office/products/product-form.ts` искать контрагента в порядке хоста: фрагмент

<!-- prettier-ignore -->
```ts
  const counterparty = activeFirstByName(counterparties).find((each) =>
```

заменить на

<!-- prettier-ignore -->
```ts
  const counterparty = counterparties.find((each) =>
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "the cloud's way"`
Expected: FAIL — найден не тот контрагент: `"name": "ООО «Северный берег»"`.

Мутация 4. В `apps/standalone/src/office/products/ProductDialog.tsx` не разбирать конфликт GTIN: фрагмент

<!-- prettier-ignore -->
```tsx
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS);
```

заменить на

<!-- prettier-ignore -->
```tsx
      const outcome = writeFailure(error, PRODUCT_FIELDS);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "taken GTIN"`
Expected: FAIL — `Unable to find an element with the text: Этот GTIN уже у товара в работе`.

Мутация 5. В `apps/standalone/src/office/products/ProductDialog.tsx` не оставлять собственную группу товара выбором: фрагмент

<!-- prettier-ignore -->
```tsx
  if (ownGroup !== null && !groupOptions.some((option) => option.value === String(ownGroup))) {
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (false && !groupOptions.some((option) => option.value === String(ownGroup))) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "group"`
Expected: FAIL — 2 теста: `expected [ 'Без группы', …(2) ] to deeply equal [ 'Без группы', …(3) ]` и `to have property "value" with value '8'`.

Мутация 6. В `apps/standalone/src/office/products/ProductDialog.tsx` не выключать выбор группы без справочника: фрагмент

<!-- prettier-ignore -->
```tsx
            onValueChange={field.onChange}
            disabled={!groups.isSuccess}
```

заменить на

<!-- prettier-ignore -->
```tsx
            onValueChange={field.onChange}
```

Run: та же команда, что у мутации 5.
Expected: FAIL — `to have property "disabled" with value true`.

Мутация 7. В `apps/standalone/src/office/products/ProductDialog.tsx` не сортировать группы по названию: фрагмент

<!-- prettier-ignore -->
```tsx
    ...[...(groups.data ?? [])]
      .sort((a, b) => GROUP_NAMES.compare(a.name, b.name))
```

заменить на

<!-- prettier-ignore -->
```tsx
    ...[...(groups.data ?? [])]
```

Run: та же команда, что у мутации 5.
Expected: FAIL — `expected [ 'Без группы', …(3) ] to deeply equal [ 'Без группы', …(3) ]`.

Мутация 8. В `apps/standalone/src/office/products/product-form.ts` забыть вместимость паллеты в подсказке черновика: фрагмент

<!-- prettier-ignore -->
```ts
    values.boxCapacity.trim() === "" ||
    values.palletBoxCapacity.trim() === ""
```

заменить на

<!-- prettier-ignore -->
```ts
    values.boxCapacity.trim() === ""
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "stays a draft"`
Expected: FAIL — `Unable to find an element with the text: Без группы и вместимостей товар остаётся черновиком.`

Мутация 9. В `apps/standalone/src/office/products/ProductDialog.tsx` не слать флажок архива: фрагмент

<!-- prettier-ignore -->
```tsx
      : api.updateProduct(token, product.id, productUpdate(input, archived, product.rev)),
```

заменить на

<!-- prettier-ignore -->
```tsx
      : api.updateProduct(token, product.id, productUpdate(input, false, product.rev)),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "whole record"`
Expected: FAIL — `expected [ [ 'office-session-token', …(2) ] ] to strictly equal [ [ 'office-session-token', …(2) ] ]`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  sorts a refused write: a `validation_failed` field or a `conflict`
  constraint the form names (`line_name`, `login`, `badge`) goes under that field,
  `stale_revision` offers to reload, anything else is an alert
```

заменить на

<!-- prettier-ignore -->
```text
  sorts a refused write: a `validation_failed` field or a `conflict`
  constraint the form names (`line_name`, `login`, `badge`, `gtin14`) goes under
  that field, `stale_revision` offers to reload, anything else is an alert
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  page. The groups are a static lookup, not read again while cached
  (`staleTime: Infinity`).

## Marking rules
```

заменить на

<!-- prettier-ignore -->
```text
  page. The groups are a static lookup, not read again while cached
  (`staleTime: Infinity`). Both roles add and change products
  (`useCan("editCatalog")`; no role lacks it, so the page has no read-only
  view). One dialog adds and changes a product: an edit sends the whole
  record with the loaded revision, archiving is its «В архиве» box, and
  there is no delete. The GTIN may change: a GTIN another product in use
  holds is `conflict` on `gtin14` under the GTIN, on adding, on a change and
  on coming back from the archive. Once the GTIN is valid the dialog shows
  the 14 digits it is saved as when they differ from what was typed, and
  whose GS1 prefix it has: the organization's, else the first counterparty's
  (active ones first, by name), else nobody's, as the cloud's
  `checkGtinOwner`. That never blocks a save and is left out while the
  organization or the counterparties do not load. A product without a group
  or both capacities gets a note that it stays a draft. The group select
  offers the lookup by name and keeps the product's own group when the
  lookup lacks it; while the lookup does not load it is off and the group
  goes out unchanged.

## Marking rules
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  и GTIN, отбор по состоянию и страницы по 25 — в самом экране: хост отдаёт
  список целиком.
```

заменить на

<!-- prettier-ignore -->
```text
  и GTIN, отбор по состоянию и страницы по 25 — в самом экране: хост отдаёт
  список целиком. Добавляют и меняют товары обе роли, одним окном на добавление
  и правку: правка отправляет запись целиком с `expectedRev`, архив — флажок
  «В архиве», удаления нет. GTIN можно изменить; занятый товаром в работе GTIN —
  ошибка под полем GTIN (`conflict` с `constraint: gtin14`) при добавлении,
  смене и возврате из архива. Для правильного GTIN окно показывает 14 цифр,
  которыми он сохранится, и чей у него префикс GS1 — организации, контрагента
  или ничей (как `checkGtinOwner` облака); подсказка не мешает сохранить. Товар
  без группы или вместимостей помечен как черновик.
```

Перечитать раздел «Office pages» в `AGENTS.md` и §5.5 спецификации целиком: описание диалога совпадает с тем, что он делает (шаблоны по умолчанию — задача 6).

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/products/ProductDialog.tsx apps/standalone/src/office/products/product-form.ts apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/product-dialog.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -nF '\u0' apps/standalone/src/i18n/ru.json`
Expected: чисто; первый `grep` находит только `src/host/pairing-code.ts:66`, второй — ничего.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 40 файлов, 930 тестов (914 + 16).

```bash
git add apps/standalone/src/office/products/ProductDialog.tsx apps/standalone/src/office/products/product-form.ts apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/product-dialog.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): диалог товара — добавление, правка, архив, подсказки о GTIN" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Шаблоны по умолчанию в диалоге товара, отказ по удалённому шаблону (D9) и сверка документов

Диалог товара получает два необязательных выбора — «Шаблон короба» и «Шаблон паллеты». Выбор предлагает «Не выбран» и шаблоны, которые `templateFitsSlot` (задача 1) пускает в слот для текущей группы формы (без группы — только шаблоны для всех категорий), по названию. Предпочтение товара, которое больше не подходит (шаблон выключен, сужен или группа в форме сменилась), остаётся отдельным выбором с пометкой «— не подходит» и уходит, пока его не сменили: хост его принимает, а молчаливый сброс стёр бы выбор, которого пользователь не трогал. Выбранный в форме шаблон, переставший подходить после смены группы, помечается так же. Идентификатор, которого нет в списке, показан началом («Шаблон a3b4c5d6… — нет в списке»). Пока список шаблонов не загрузился, оба выбора выключены с подсказкой, а идентификаторы уходят без изменений — неудачное чтение их не стирает.

Список шаблонов (`useTemplates`, `officeKeys.templates`) читается при каждом открытии диалога (`staleTime` 0): шаблон могли выключить, сузить или удалить. Отсюда D9: форма, открытая до удаления её шаблона, шлёт старый идентификатор, и хост отвечает `validation_failed` на `defaultBoxTemplateId` или `defaultPalletTemplateId` (ссылки он проверяет раньше ревизии), а не `stale_revision`. `writeFailure` получает четвёртый необязательный параметр `staleFields` — имена полей хоста, чей отказ означает устаревшую форму; диалог передаёт `PRODUCT_STALE_FIELDS` и показывает то же «Загрузить заново», что у `stale_revision`. «Загрузить заново» закрывает диалог и сразу перечитывает товары, а шаблоны перечитает следующее открытие диалога — это закрепляет тест (второе чтение списка шаблонов).

Задача заканчивается сверкой документов: каждый затронутый планом раздел `AGENTS.md` и спецификации перечитывается целиком.

**Files:**

- Create: `apps/standalone/src/office/products/template-options.ts`
- Modify: `apps/standalone/src/office/products/ProductDialog.tsx`, `apps/standalone/src/office/products/product-form.ts`, `apps/standalone/src/office/products/product-queries.ts`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/form-errors.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/product-dialog.test.tsx`, `apps/standalone/test/form-errors.test.ts`
- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates», «Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `templateFitsSlot(template, slot)` — `src/lib/template-eligibility.ts`, `toGroupCode` — `src/lib/rules.ts` (задача 1);
  - `HostApi.listTemplates`, `type LabelTemplateSummary` (задача 2);
  - `ProductDialog`, `PRODUCT_FIELDS`, `PRODUCT_CONFLICTS`, `productFields` (задача 5); `useProductGroups()` (задача 4); `writeFailure(error, fields, conflicts)` — `src/office/form-errors.ts`.
- Produces:
  - `writeFailure<F extends string>(error: unknown, fields, conflicts = {}, staleFields: readonly string[] = []): WriteFailure<F>` — отказ `validation_failed` по полю из `staleFields` даёт `{ kind: "stale" }`;
  - `PRODUCT_STALE_FIELDS = ["defaultBoxTemplateId", "defaultPalletTemplateId"] as const` — `src/office/products/product-form.ts`;
  - `officeKeys.templates` (`["office", "templates"]`), `useTemplates()` — `src/office/products/product-queries.ts`;
  - `interface TemplateOption { value: string; label: string }`, `templateOptions(templates: readonly LabelTemplateSummary[] | undefined, purpose: "box" | "pallet", group: number | null, kept: readonly string[], t: TFunction): TemplateOption[]` — `src/office/products/template-options.ts`;
  - ключи `office.products.fields.boxTemplate`, `fields.palletTemplate`, `fields.templateHint`, `noTemplate`, `templateUnfit`, `templateId`, `templateMissing`, `templatesLoading`, `templatesUnavailable`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/form-errors.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    });
  });

  it("never takes an inherited object key for a field or a constraint", () => {
    expect(writeFailure(rejected("constructor"), FIELDS)).toEqual({
      kind: "alert",
```

заменить на

<!-- prettier-ignore -->
```ts
    });
  });

  it("reads a refusal of a field the form names as out of date like a stale write", () => {
    const stale = ["defaultBoxTemplateId", "defaultPalletTemplateId"];
    expect(writeFailure(rejected("defaultBoxTemplateId"), FIELDS, {}, stale)).toEqual({
      kind: "stale",
    });
    expect(writeFailure(rejected("defaultPalletTemplateId"), FIELDS, {}, stale)).toEqual({
      kind: "stale",
    });
    // Before the form names the field so, it has no place: an alert.
    expect(writeFailure(rejected("defaultBoxTemplateId"), FIELDS)).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    // Another field still goes under itself, and a conflict is still a conflict.
    expect(writeFailure(rejected("gln"), FIELDS, {}, stale)).toEqual({
      kind: "field",
      field: "gln",
      message: "rules.rejected",
    });
    expect(writeFailure(conflict("defaultBoxTemplateId"), FIELDS, {}, stale)).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });

  it("never takes an inherited object key for a field or a constraint", () => {
    expect(writeFailure(rejected("constructor"), FIELDS)).toEqual({
      kind: "alert",
```

2. В `apps/standalone/test/product-dialog.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { CounterpartyRecord, OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import { gtinOwner } from "../src/office/products/product-form.js";
import {
  fakeOfficeSession,
```

заменить на

<!-- prettier-ignore -->
```tsx
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type {
  CounterpartyRecord,
  LabelTemplateSummary,
  OfficeProduct,
  ProductGroup,
} from "../src/host/protocol.js";
import { gtinOwner } from "../src/office/products/product-form.js";
import {
  fakeOfficeSession,
```

3. В `apps/standalone/test/product-dialog.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  rev: 72,
};

function session(user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.listProducts.mockResolvedValue([MILK, AYRAN]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([NORTH, OLD]);
  return fake;
}

function type(label: string, value: string): void {
```

заменить на

<!-- prettier-ignore -->
```tsx
  rev: 72,
};

/** A template summary: a box template for every category unless told otherwise. */
function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 60,
    ...data,
  } satisfies LabelTemplateSummary;
}

const BOX_58 = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
const WATER_58 = "8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d";
const OLD_BOX = "9e3a6d4c-1f5b-4a7c-8d8e-3f4a5b6c7d8e";
const PALLET = "0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f";
const TEMPLATES: LabelTemplateSummary[] = [
  summary(MILK_58, "Молоко 58×40", { chzProductGroupCodes: [8] }),
  summary(WATER_58, "Вода 58×40", { chzProductGroupCodes: [13] }),
  summary(BOX_58, "Коробка 58×40"),
  summary(OLD_BOX, "Старая коробка", { enabled: false }),
  summary(PALLET, "Паллета 100×150", { purpose: "pallet" }),
  summary("1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a", "Дубликат", { purpose: "product_duplicate" }),
];

function session(user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.listProducts.mockResolvedValue([MILK, AYRAN]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.listTemplates.mockResolvedValue(TEMPLATES);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([NORTH, OLD]);
  return fake;
}

/** The labels a select offers, top to bottom. */
function choices(label: string): (string | null)[] {
  return within(screen.getByLabelText(label))
    .getAllByRole("option")
    .map((option) => option.textContent);
}

function type(label: string, value: string): void {
```

4. В `apps/standalone/test/product-dialog.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  });
});

```

заменить на

<!-- prettier-ignore -->
```tsx
  });
});

describe("office product dialog: default templates", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  /** Opens a product's dialog and waits for the templates. */
  async function openEdit(fake: FakeOfficeSession, name: string): Promise<void> {
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: `Изменить товар «${name}»` }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
  }

  it("offers in each slot the templates that fit the product's group, by name, and none", async () => {
    const fake = session();
    fake.api.createProduct.mockResolvedValue({
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    });
    await openCreate(fake);
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    // No group yet: only templates for every category fit.
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40"]);
    expect(choices("Шаблон паллеты")).toEqual(["Не выбран", "Паллета 100×150"]);
    type("Товарная группа", "8");
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40", "Молоко 58×40"]);
    type("Шаблон короба", MILK_58);
    type("Шаблон паллеты", PALLET);
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(fake.api.createProduct).toHaveBeenCalledTimes(1));
    expect(fake.api.createProduct.mock.calls[0]?.[1]).toMatchObject({
      chzProductGroupCode: 8,
      defaultBoxTemplateId: MILK_58,
      defaultPalletTemplateId: PALLET,
    });
  });

  it("keeps a preference that no longer fits as a marked choice, and sends it unless it is changed", async () => {
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultBoxTemplateId: OLD_BOX }]);
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко 3,2% 1 л", rev: 81 });
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Коробка 58×40",
      "Молоко 58×40",
      "Старая коробка — не подходит",
    ]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", OLD_BOX);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2].defaultBoxTemplateId).toBe(OLD_BOX);
  });

  it("keeps a chosen template as a marked choice when the group changes and it stops fitting", async () => {
    const fake = session();
    fake.api.updateProduct.mockResolvedValue({ ...MILK, chzProductGroupCode: 13, rev: 81 });
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", MILK_58);
    type("Товарная группа", "13");
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Вода 58×40",
      "Коробка 58×40",
      "Молоко 58×40 — не подходит",
    ]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", MILK_58);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      chzProductGroupCode: 13,
      defaultBoxTemplateId: MILK_58,
    });
  });

  it("names a preference the template list does not have", async () => {
    const fake = session();
    const gone = "2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b";
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultPalletTemplateId: gone }]);
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    expect(choices("Шаблон паллеты")).toEqual([
      "Не выбран",
      "Паллета 100×150",
      "Шаблон 2b6d9a7f… — нет в списке",
    ]);
  });

  it("keeps the template choices off while the templates do not load, and sends the preferences unchanged", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValue(hostError("internal", 500));
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко 3,2% 1 л", rev: 81 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(
      await screen.findAllByText("Список шаблонов не загрузился: шаблоны останутся как есть."),
    ).toHaveLength(2);
    const box = screen.getByLabelText("Шаблон короба");
    expect(box).toHaveProperty("disabled", true);
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Шаблон a3b4c5d6…"]);
    expect(box).toHaveProperty("value", MILK_58);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      defaultBoxTemplateId: MILK_58,
      defaultPalletTemplateId: null,
    });
  });

  it("reads a refused template preference, its template deleted meanwhile, as a stale change: the products again now, the templates when the dialog opens again", async () => {
    const fake = session();
    fake.api.updateProduct.mockRejectedValueOnce(VALIDATION("defaultBoxTemplateId"));
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(2));
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });
});

```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts test/product-dialog.test.tsx`
Expected: FAIL — 7 из 33: в `test/form-errors.test.ts` 1 из 11 (`expected { kind: 'alert', …(1) } to deeply equal { kind: 'stale' }`), в `test/product-dialog.test.tsx` 6 из 22 (пять — `Unable to find a label with the text of: Шаблон короба`, один — `Unable to find an element with the text: Список шаблонов не загрузился: шаблоны останутся как есть.`).

- [ ] **Step 3: Выбор шаблонов и отказ по удалённому шаблону**

1. В `apps/standalone/src/office/form-errors.ts`, фрагмент

<!-- prettier-ignore -->
```ts
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
```

заменить на

<!-- prettier-ignore -->
```ts
 * the rest is `alertFailure`. `fields` maps the host's field names to the
 * form's; a bare field name says `rules.rejected`, a `FieldMessage` its own
 * text. `conflicts` maps constraint names (`line_name`, `login`, `badge`)
 * the same way. `staleFields` names host fields whose `validation_failed`
 * means the form is out of date, so it reads as `stale_revision`: a product's
 * template preferences, which the host checks before the revision, so a form
 * opened before its template was deleted is refused on the preference.
 */
export function writeFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F | FieldMessage<F>>>,
  conflicts: Readonly<Record<string, FieldMessage<F>>> = {},
  staleFields: readonly string[] = [],
): WriteFailure<F> {
  if (error instanceof HostError) {
    const constraint = error.details.constraint;
```

2. В `apps/standalone/src/office/form-errors.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      }
    }
    const path = error.field;
    const target = path === null ? undefined : own(fields, path);
    if (typeof target === "string") {
      return { kind: "field", field: target, message: "rules.rejected" };
```

заменить на

<!-- prettier-ignore -->
```ts
      }
    }
    const path = error.field;
    if (path !== null && staleFields.includes(path)) return { kind: "stale" };
    const target = path === null ? undefined : own(fields, path);
    if (typeof target === "string") {
      return { kind: "field", field: target, message: "rules.rejected" };
```

3. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  badgeSalt: ["office", "badge-salt"],
  productGroups: ["office", "product-groups"],
  products: ["office", "products"],
} as const;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  badgeSalt: ["office", "badge-salt"],
  productGroups: ["office", "product-groups"],
  products: ["office", "products"],
  templates: ["office", "templates"],
} as const;

/**
```

4. В `apps/standalone/src/office/products/product-queries.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
}

```

заменить на

<!-- prettier-ignore -->
```ts
  });
}

/**
 * The label templates without their layouts (`GET /v1/office/templates`):
 * read again whenever a product dialog opens, since a template may have been
 * disabled, narrowed or deleted since.
 */
export function useTemplates() {
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token));
}

```

5. Create `apps/standalone/src/office/products/template-options.ts`:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";

/** Template names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

export interface TemplateOption {
  value: string;
  label: string;
}

/**
 * The choices of a product's default template for one slot: none (`""`), then
 * every template that fits the slot for the form's group (`templateFitsSlot`:
 * enabled, of the slot's purpose, covering the group), by name. Each id in
 * `kept` that does not fit stays a choice of its own, marked: the product's
 * own preference, which a template disabled or narrowed since, or a group
 * changed in the form, does not take away, and the form's current choice.
 * `templates` is `undefined` while the list is not loaded.
 */
export function templateOptions(
  templates: readonly LabelTemplateSummary[] | undefined,
  purpose: "box" | "pallet",
  group: number | null,
  kept: readonly string[],
  t: TFunction,
): TemplateOption[] {
  const fitting = (templates ?? [])
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const options: TemplateOption[] = [
    { value: "", label: t("office.products.noTemplate") },
    ...fitting.map((template) => ({ value: template.id, label: template.name })),
  ];
  for (const id of kept) {
    if (id === "" || options.some((option) => option.value === id)) continue;
    const template = templates?.find((each) => each.id === id);
    const short = id.slice(0, 8);
    options.push({
      value: id,
      label:
        template !== undefined
          ? t("office.products.templateUnfit", { name: template.name })
          : templates === undefined
            ? t("office.products.templateId", { id: short })
            : t("office.products.templateMissing", { id: short }),
    });
  }
  return options;
}
```

6. В `apps/standalone/src/office/products/product-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export const PRODUCT_CONFLICTS = {
  gtin14: { field: "gtin14", message: "office.products.errors.gtinTaken" },
} as const;

/** A number as the form holds it: blank for none. */
function numberText(value: number | null): string {
```

заменить на

<!-- prettier-ignore -->
```ts
export const PRODUCT_CONFLICTS = {
  gtin14: { field: "gtin14", message: "office.products.errors.gtinTaken" },
} as const;

/**
 * The template preferences: the host checks them before the revision, so a
 * form opened before its template was deleted is refused on one of them, not
 * as `stale_revision`. The dialog treats that as a stale write (`writeFailure`).
 */
export const PRODUCT_STALE_FIELDS = ["defaultBoxTemplateId", "defaultPalletTemplateId"] as const;

/** A number as the form holds it: blank for none. */
function numberText(value: number | null): string {
```

7. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { Checkbox, Input, Select } from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, toGtin14 } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { Checkbox, Input, Select } from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, toGroupCode, toGtin14 } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
```

8. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  gtinOwner,
  PRODUCT_CONFLICTS,
  PRODUCT_FIELDS,
  productFields,
  productFieldsSchema,
  staysDraft,
  toProductInput,
  type GtinOwner,
  type ProductFields,
} from "./product-form.js";
import { useProductGroups } from "./product-queries.js";

/** Group names in Russian order, with numbers by value. */
const GROUP_NAMES = new Intl.Collator("ru", { numeric: true });
```

заменить на

<!-- prettier-ignore -->
```tsx
  gtinOwner,
  PRODUCT_CONFLICTS,
  PRODUCT_FIELDS,
  PRODUCT_STALE_FIELDS,
  productFields,
  productFieldsSchema,
  staysDraft,
  toProductInput,
  type GtinOwner,
  type ProductFields,
} from "./product-form.js";
import { useProductGroups, useTemplates } from "./product-queries.js";
import { templateOptions } from "./template-options.js";

/** Group names in Russian order, with numbers by value. */
const GROUP_NAMES = new Intl.Collator("ru", { numeric: true });
```

9. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  product: OfficeProduct | null;
  onClose: () => void;
  onSaved: (product: OfficeProduct) => void;
  /** The product changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Adds a product, or changes one: the host takes the whole record with the
 * loaded revision, and archiving is its `archived` flag (no delete). The GTIN
 * may change too. Once it is valid, the dialog shows the 14 digits it is saved
 * as and whose GS1 prefix it has; neither blocks a save.
 */
export function ProductDialog({ product, onClose, onSaved, onReload }: ProductDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const groups = useProductGroups();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
```

заменить на

<!-- prettier-ignore -->
```tsx
  product: OfficeProduct | null;
  onClose: () => void;
  onSaved: (product: OfficeProduct) => void;
  /**
   * The product changed on the host, or a template it names was deleted:
   * close and load the list again.
   */
  onReload: () => void;
}

/**
 * Adds a product, or changes one: the host takes the whole record with the
 * loaded revision, and archiving is its `archived` flag (no delete). The GTIN
 * may change too. Once it is valid, the dialog shows the 14 digits it is saved
 * as and whose GS1 prefix it has; neither blocks a save. The two default
 * templates offer what fits the product's group, keep a preference that no
 * longer fits as a marked choice, and are left as they are, never cleared,
 * while the template list does not load.
 */
export function ProductDialog({ product, onClose, onSaved, onReload }: ProductDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const groups = useProductGroups();
  const templates = useTemplates();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
```

10. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    });
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const write: ProductWrite = { input: toProductInput(values), archived: values.archived };
    let saved: OfficeProduct;
    try {
      saved = await save.mutateAsync(write);
    } catch (error) {
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
```

заменить на

<!-- prettier-ignore -->
```tsx
    });
  }

  const templatesHint = templates.isSuccess
    ? t("office.products.fields.templateHint")
    : templates.isError
      ? t("office.products.templatesUnavailable")
      : t("office.products.templatesLoading");

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const write: ProductWrite = { input: toProductInput(values), archived: values.archived };
    let saved: OfficeProduct;
    try {
      saved = await save.mutateAsync(write);
    } catch (error) {
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS, PRODUCT_STALE_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
```

11. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        {...fieldError(errors.shelfLifeDays?.message)}
        {...register("shelfLifeDays")}
      />
      {product !== null && (
        <Controller
          control={control}
```

заменить на

<!-- prettier-ignore -->
```tsx
        {...fieldError(errors.shelfLifeDays?.message)}
        {...register("shelfLifeDays")}
      />
      {(
        [
          ["defaultBoxTemplateId", "box", "office.products.fields.boxTemplate"],
          ["defaultPalletTemplateId", "pallet", "office.products.fields.palletTemplate"],
        ] as const
      ).map(([name, purpose, label]) => (
        <Controller
          key={name}
          control={control}
          name={name}
          render={({ field }) => (
            <Select
              native
              label={t(label)}
              hint={templatesHint}
              options={templateOptions(
                templates.data,
                purpose,
                toGroupCode(group),
                [product?.[name] ?? "", field.value],
                t,
              )}
              value={field.value}
              onValueChange={field.onChange}
              disabled={!templates.isSuccess}
            />
          )}
        />
      ))}
      {product !== null && (
        <Controller
          control={control}
```

12. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "optional": "Необязательно",
        "archived": "В архиве"
      },
```

заменить на

<!-- prettier-ignore -->
```json
        "optional": "Необязательно",
        "archived": "В архиве",
        "boxTemplate": "Шаблон короба",
        "palletTemplate": "Шаблон паллеты",
        "templateHint": "Необязательно: станция возьмёт этот шаблон первым, пока он подходит товару"
      },
```

13. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "groupsUnavailable": "Справочник групп не загрузился: группу сейчас не изменить.",
```

заменить на

<!-- prettier-ignore -->
```json
      "groupsUnavailable": "Справочник групп не загрузился: группу сейчас не изменить.",
      "noTemplate": "Не выбран",
      "templateUnfit": "{{name}} — не подходит",
      "templateId": "Шаблон {{id}}…",
      "templateMissing": "Шаблон {{id}}… — нет в списке",
      "templatesLoading": "Загружаем шаблоны…",
      "templatesUnavailable": "Список шаблонов не загрузился: шаблоны останутся как есть.",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts test/product-dialog.test.tsx`
Expected: PASS — 33 теста (11 и 22).

Run: то же с `--reporter=verbose` — stderr пуст; затем те же файлы под стендом с задержкой `setImmediate` — PASS, 33.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/office/form-errors.ts` не проверять `staleFields`: фрагмент

<!-- prettier-ignore -->
```ts
    if (path !== null && staleFields.includes(path)) return { kind: "stale" };
    const target = path === null ? undefined : own(fields, path);
```

заменить на

<!-- prettier-ignore -->
```ts
    const target = path === null ? undefined : own(fields, path);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts test/product-dialog.test.tsx -t "stale"`
Expected: FAIL — 2 теста: `expected { kind: 'alert', …(1) } to deeply equal { kind: 'stale' }` и `Unable to find an element with the text: Данные изменились, пока вы их редактировали. Обновите их и повторите.`

Мутация 2. В `apps/standalone/src/office/products/ProductDialog.tsx` не передавать `PRODUCT_STALE_FIELDS`: фрагмент

<!-- prettier-ignore -->
```tsx
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS, PRODUCT_STALE_FIELDS);
```

заменить на

<!-- prettier-ignore -->
```tsx
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "stale change"`
Expected: FAIL — `Unable to find an element with the text: Данные изменились, пока вы их редактировали. Обновите их и повторите.`

Мутация 3. В `apps/standalone/src/office/products/ProductDialog.tsx` не держать неподходящие идентификаторы выбором: фрагмент

<!-- prettier-ignore -->
```tsx
                [product?.[name] ?? "", field.value],
```

заменить на

<!-- prettier-ignore -->
```tsx
                [],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "preference"`
Expected: FAIL — 3 теста: `expected [ 'Не выбран', 'Коробка 58×40', …(1) ] to deeply equal [ 'Не выбран', 'Коробка 58×40', …(2) ]`, `expected [ 'Не выбран', 'Паллета 100×150' ] to deeply equal [ Array(3) ]`, `expected [ 'Не выбран' ] to deeply equal [ 'Не выбран', 'Шаблон a3b4c5d6…' ]`.

Мутация 4. В `apps/standalone/src/office/products/ProductDialog.tsx` не выключать выбор шаблонов без списка: фрагмент

<!-- prettier-ignore -->
```tsx
              onValueChange={field.onChange}
              disabled={!templates.isSuccess}
```

заменить на

<!-- prettier-ignore -->
```tsx
              onValueChange={field.onChange}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "do not load"`
Expected: FAIL — `to have property "disabled" with value true`.

Мутация 5. В `apps/standalone/src/office/products/product-queries.ts` не перечитывать шаблоны при новом открытии: фрагмент

<!-- prettier-ignore -->
```ts
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token));
```

заменить на

<!-- prettier-ignore -->
```ts
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token), {
    staleTime: Infinity,
  });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "stale change"`
Expected: FAIL — `expected "vi.fn()" to be called 2 times, but got 1 times`.

Мутация 6. В `apps/standalone/src/office/products/template-options.ts` не сверять категории шаблона с группой: фрагмент

<!-- prettier-ignore -->
```ts
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
```

заменить на

<!-- prettier-ignore -->
```ts
    .filter((template) => template.enabled && template.purpose === purpose)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "fit the product's group"`
Expected: FAIL — `expected [ 'Не выбран', 'Вода 58×40', …(2) ] to deeply equal [ 'Не выбран', 'Коробка 58×40' ]`.

Мутация 7. В `apps/standalone/src/office/products/ProductDialog.tsx` подбирать шаблоны по группе товара, а не формы: фрагмент

<!-- prettier-ignore -->
```tsx
                toGroupCode(group),
```

заменить на

<!-- prettier-ignore -->
```tsx
                product?.chzProductGroupCode ?? null,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/product-dialog.test.tsx -t "group changes"`
Expected: FAIL — `expected [ 'Не выбран', 'Коробка 58×40', …(1) ] to deeply equal [ 'Не выбран', 'Вода 58×40', …(2) ]`.

- [ ] **Step 6: Документы и сверка**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
(the references are checked before the revision), not `stale_revision`:
nothing is written, and the office (plan 1e2) re-reads the product and the
template list on that error. The station will choose a template by the
product's preference if it still fits, then the category's default, then the
organization's, then the operator's choice (plan 2a); the comment in migration
`0008_catalog.sql` names only the category's default and the organization's and
omits the product's preference, and an applied migration is never edited. (The
```

заменить на

<!-- prettier-ignore -->
```text
(the references are checked before the revision), not `stale_revision`:
nothing is written, and the office's product dialog takes it as a stale
write: «Загрузить заново» reads the products again at once, and the
template list is read again whenever a dialog opens. The station will
choose a template by the product's preference if it still fits, then the
category's default, then the organization's, then the operator's choice
(plan 2a); the comment in migration `0008_catalog.sql` names only the
category's default and the organization's and omits the product's
preference, and an applied migration is never edited. (The
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
Plan 1e1 is host-only: these shapes have Rust types and fixtures; their Zod
schemas, `ENTITIES` entries and station copies come with plan 1e2, and the
wizard's `templates` with plan 1e3 (spec §4.5).
```

заменить на

<!-- prettier-ignore -->
```text
Plan 1e1 built the host's side and plan 1e2 the webview's: Zod schemas and
request builders for every catalog shape (`test/protocol.test.ts` reads every
fixture of plan 1e1, `test/template-eligibility.test.ts` the slot rule's),
the station's copies of products, templates and category defaults
(«Reference sync», «Local database») and the office's «Товары» page («Office
pages»). The template screens, the defaults screen and the wizard's
`templates` come with plan 1e3; the `HostApi` methods and the builders they
call are in place.
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  constraint the form names (`line_name`, `login`, `badge`, `gtin14`) goes under
  that field, `stale_revision` offers to reload, anything else is an alert
```

заменить на

<!-- prettier-ignore -->
```text
  constraint the form names (`line_name`, `login`, `badge`, `gtin14`) goes under
  that field, `stale_revision` offers to reload, and so does a
  `validation_failed` on a field the form names as out of date (`staleFields`:
  a product's template preferences), anything else is an alert
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  lookup lacks it; while the lookup does not load it is off and the group
  goes out unchanged.

## Marking rules
```

заменить на

<!-- prettier-ignore -->
```text
  lookup lacks it; while the lookup does not load it is off and the group
  goes out unchanged. The two default templates offer what `templateFitsSlot`
  accepts for the form's group and the slot, by name, and «Не выбран». A
  preference that no longer fits (disabled, narrowed, or the group changed in
  the form) stays a choice marked «не подходит» and goes out unless changed,
  since the host takes it; a change of the group never resets a choice. While
  the template list does not load both selects are off and the preferences
  go out unchanged. A `validation_failed` on `defaultBoxTemplateId` or
  `defaultPalletTemplateId` reads as a stale write (`PRODUCT_STALE_FIELDS`):
  the form was opened before its template was deleted. «Загрузить заново»
  closes the dialog and reads the products again; the templates are read
  again whenever a dialog opens.

## Marking rules
```

5. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  или ничей (как `checkGtinOwner` облака); подсказка не мешает сохранить. Товар
  без группы или вместимостей помечен как черновик.
```

заменить на

<!-- prettier-ignore -->
```text
  или ничей (как `checkGtinOwner` облака); подсказка не мешает сохранить. Товар
  без группы или вместимостей помечен как черновик. Шаблоны короба и паллеты
  товара предлагают то, что подходит его группе (`templateFitsSlot`), и «Не
  выбран»; шаблон, который перестал подходить, остаётся в списке с пометкой «не
  подходит» и уходит на хост, пока его не сменили; пока список шаблонов не
  загрузился, оба выбора выключены и уходят без изменений. Отказ
  `validation_failed` по шаблону товара (шаблон удалили, пока форма была
  открыта) окно принимает за `stale_revision` и предлагает загрузить данные
  заново.
```

Сверка: перечитать целиком разделы `AGENTS.md` «Catalog and label templates», «Reference sync», «Local database», «Protocol», «Office pages» и §4.4, §4.5, §5.3, §5.4, §5.5, §6 спецификации. Каждое предложение говорит, что делает код после плана: схемы Zod каталога есть (больше нигде не сказано, что фикстуры плана 1e1 читает только Rust, кроме экрана мастера с `templates` — он за планом 1e3), правило слота читают обе стороны, отказ по удалённому шаблону ведёт к «Загрузить заново». Run: `grep -n "1e2" apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — каждое совпадение говорит о сделанном, а не о будущем.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/products/template-options.ts apps/standalone/src/office/products/ProductDialog.tsx apps/standalone/src/office/products/product-form.ts apps/standalone/src/office/products/product-queries.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/form-errors.ts apps/standalone/src/i18n/ru.json apps/standalone/test/product-dialog.test.tsx apps/standalone/test/form-errors.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -nF '\u0' apps/standalone/src/i18n/ru.json`
Expected: чисто; первый `grep` находит только `src/host/pairing-code.ts:66`, второй — ничего.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 40 файлов, 937 тестов (930 + 7).

```bash
git add apps/standalone/src/office/products/template-options.ts apps/standalone/src/office/products/ProductDialog.tsx apps/standalone/src/office/products/product-form.ts apps/standalone/src/office/products/product-queries.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/form-errors.ts apps/standalone/src/i18n/ru.json apps/standalone/test/product-dialog.test.tsx apps/standalone/test/form-errors.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): шаблоны по умолчанию в диалоге товара и отказ по удалённому шаблону" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 40 файлов, 937 тестов (до плана 37 и 813).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/rules.test.ts test/template-eligibility.test.ts test/protocol.test.ts test/api.test.ts test/reference-sync.test.ts test/local-executor.test.ts test/products-page.test.tsx test/product-dialog.test.tsx test/form-errors.test.ts`
Expected: PASS — 9 файлов, 432 теста; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 432; файлы стенда удалены.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок; у `typecheck` и `lint` нет предупреждений, у `build` — только прежнее предупреждение Vite о чанках больше 500 kB (его даёт и не тронутый планом `PairingDataMatrix`).

- [ ] **Step 2: Cargo**

Сборка вебвью из шага 1 уже лежит в `apps/standalone/dist` — оболочка её встраивает.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: чисто, без предупреждений.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --no-run`
Expected: собирается без предупреждений.

Наборы гонятся частями (каждый `TestApp` хоста платит PBKDF2, единый прогон не укладывается в окно), вывод каждой части — в свой файл журнала:

Run (в песочнице): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --test badges --test bootstrap --test changes --test commit --test counterparties --test device_line --test devices --test feed_machine --test foundation --test lines --test office_admin --test office_auth --test operators --test product_groups --test products --test template_defaults --test templates --test fixtures --test local_db`
Expected: PASS — 19 наборов, 244 теста (хост 198, `proto` 34, оболочка 12).

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --lib --bins --test claim --test connection --test device --test host_probe --test host_probe_proxy --test ipc --test line --test hello --test platform --test no_secrets_in_logs --test changes_stream --test pairing --test pairing_codes`
Expected: PASS — 19 наборов, 209 тестов (хост 109, `proto` 5, оболочка 95).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --doc`
Expected: PASS — 3 пустых набора (0 тестов); последняя стадия молчит минутами.

Итог считает скрипт по файлам журнала (строки `test result:` и предшествующие им `Running`, а не `grep | awk` через `rtk`): 41 набор, 453 теста — хост 307, `proto` 39, оболочка 107 (до плана 106: новый тест `one_value_of_a_few_mebibytes_passes_the_limits`).

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check 335583ce7`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -nF '\u0' apps/standalone/src/i18n/ru.json apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/migrations/0004_catalog.sql`
Expected: чисто; первый `grep` находит только `src/host/pairing-code.ts:66`, второй — ничего.

Run: `git diff --stat 335583ce7 -- apps/station packages apps/standalone/host apps/standalone/proto`; `git diff --name-only 335583ce7 -- apps/standalone/src-tauri`
Expected: первая команда — пусто; вторая — только `apps/standalone/src-tauri/migrations/0004_catalog.sql` и `apps/standalone/src-tauri/tests/local_db.rs`.

---

## Перенесено

- План 1e3 (экраны шаблонов и мастер):
  - экраны шаблонов (импорт ZPL/TSPL/JSON, форма размеров, предпросмотр) и экран умолчаний: слой протокола для них готов (`getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `getTemplateDefaults`, `updateTemplateDefaults`, сборщики `templateCreate`, `templateUpdate`, `templateDefaultsUpdate`); отказ `template_is_default` сейчас разбирает общий `errorBodySchema`, а объяснить, где стоит умолчание (`organizationDefault`, `categoryDefaults`), — дело экрана;
  - мастер шлёт `templates` (`buildDefaultLabelTemplates()` и соседи); схема тела готова и закреплена фикстурой `bootstrap-request-templates.json`, `wizard-form.ts` и экран мастера не менялись; граница тела `/v1/bootstrap` (`DefaultBodyLimit`) — решение вместе с ним;
  - порядок кодов категорий шаблона: `templateUpdate` считает переставленный список изменением и шлёт его как есть; сортировать ли коды перед отправкой — решение экрана шаблона;
  - в общей фикстуре `template-eligibility.json` нет случаев дубликата с категориями (включённый шаблон дубликата для категории 15 в слоте 15; он же в слоте организации; шаблон дубликата в слоте короба): план 1e2 не меняет `proto`, поэтому эти случаи держат только тесты вебвью (`test/template-eligibility.test.ts`, describe «template eligibility of a product duplicate…»). Добавить их в фикстуру, чтобы `templates::fits` хоста отвечал на них тоже, — первому плану, который меняет `proto`.
- План 1f (вход оператора на станции офлайн): по-прежнему сначала `hostGuard`, привязанный к подключению, и только потом чтение копий. Тот же `hostGuard` защищает и копии каталога, которые читает план 2a: две поздние порции одной станции (две отвязки с повторной привязкой к тому же хосту, пока в полёте два запроса), пришедшие старшая первой, оставляют навсегда шаблон, удалённый надгробием, или снятое умолчание категории (проба итогового ревью); одну позднюю порцию следующая синхронизация исправляет.
- План 2a (смена на станции):
  - выбор шаблона станцией — пожелание товара, если подходит (`templateFitsSlot`), затем умолчание категории, затем организации, затем выбор оператора; среди копий станция сама отбирает архивные товары и выключенные шаблоны (D6);
  - снимок макета в смене: текст `spec` в копии — `JSON.stringify` разобранного макета (ключи-целые числа первыми), а не байты хоста, поэтому дайджест считается от канонизированного макета;
  - копия товарных групп на станции (D2): сейчас её никто не читает. Варианты: засев миграцией оболочки и тест сверки с облачной `0099`, как у хоста; константа вебвью; маршрут устройства. Повод — первый экран станции, который показывает название группы;
  - защита `notQuarantinedNewer` для `org_profile`, `lines` и `site` (D4, единообразие): старая ревизия записи организации или линии сейчас может вернуться из устаревшего прогона, пока новая ждёт в карантине; вреда для доступа нет, но правило должно быть одним;
  - параметр JSON в несколько МиБ закреплён на уровне `LocalDb` (`one_value_of_a_few_mebibytes_passes_the_limits`), а не через `invoke` настоящего WebView2: проверить большую ревизию (шаблоны мастера, удаление шаблона с тысячами товаров) на станции под Windows — вместе с приёмкой смены.
  - к проверке большого параметра — случай с большим `values` в `src-tauri/tests/ipc.rs` (мок-рантайм Tauri, команда `local_transaction` с серде-разбором `Vec<LocalStatement>`) рядом с проверкой на WebView2;
  - проба итогового ревью (модель ленты хоста и четыре станции через настоящий `syncReferences` на `node:sqlite`: случайные операции хоста, поздние порции, повторы; 40 прогонов по 300 шагов сошлись к состоянию хоста) не закоммичена: когда станция начнёт читать копии, взять её основой постоянного теста, как `host/tests/feed_machine.rs` у хоста;
  - текст `spec` в копии теряет целые числа больше 2^53 через `JSON.parse`, канонизация их не вернёт: для настоящих макетов безразлично, одна оговорка к пункту о дайджесте;
- План 5: политика «строго или нестрого» для записей ленты в целом (D1 — частное решение для каталога), `MIN_PROTOCOL_VERSION`; чтение офиса, где в списке незнакомое значение перечисления (новое назначение шаблона или состояние товара от более нового хоста), падает целиком — прежняя политика протокола.
- Решения владельца ждут (как после плана 1e1):
  - оставить ли шаблоны товара по умолчанию — в облаке их нет с 2026-09-02, а план 1e2 их показывает и шлёт;
  - умолчания дубликата — в облаке их нет;
  - потолки вместимостей (100 000 штук в коробе, 10 000 коробов на паллете) — облако их не ограничивает;
  - граница тела `/v1/bootstrap`; маршрутизация CI `packages/db/migrations/**` в `standalone_rust`; уникальность контрагента (ИНН, GLN); знаки формата; политика версий протокола;
  - порядок подсказки владельца GTIN: облако берёт первого совпавшего контрагента по времени создания, у контрагента хоста этого времени нет, поэтому план 1e2 берёт действующих первыми, по названию.
  - в режиме добавления отказ по удалённому шаблону (D9) предлагает только «Загрузить заново», которое закрывает окно и теряет введённый товар: на хосте ничего не записано, форма остаётся редактируемой, но удалённый шаблон не назван, а список шаблонов в кэше его ещё предлагает. Варианты: отказ под выбором шаблона («шаблон удалён — выберите другой») с перечитыванием списка шаблонов; или перечитать шаблоны, пометить удалённый «— нет в списке» и оставить форму открытой;
- Гигиена правил (следующему плану, который трогает `src/lib/rules.ts`): у `glnRule` та же короткая схема, что была у GTIN, и нет закрепления «одна проблема» (`toHaveLength(1)`); сейчас без видимого следствия, потому что форма показывает первую ошибку.
- Импорт товаров (1С, когда появится): хост проверяет у GTIN только вид, а окно товара — ещё и контрольную цифру, поэтому товар с неверной цифрой в базе нельзя сохранить из окна, пока GTIN не исправят.

---

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-05. Там, где задачи выше расходятся с кодом в ветке, верен этот раздел.

**Поправки плана по ходу исполнения**

- Счёт тестов. План заканчивается на Vitest 40 файлов и 937 тестов, сборка — на 40 и 958 (+21): задача 2 добавила 9 тестов (34 из 148 мутантов исполнителя пережили тесты плана и `tsc`), задача 3 — 5 (37 из 159), задача 4 — 7 (13 из 47). Задачи 1, 5 и 6 добавили утверждения внутрь существующих тестов, число тестов не менялось: задача 1 — одно `toHaveLength(1)`, задача 5 — внутри 10 из 16 тестов, задача 6 — внутри 4. Факт по задачам: 841, 893, 915, 935, 951, 958 (файлов 38, 38, 38, 39, 40, 40); волна правок число не меняла. Девять файлов «Итоговой проверки» читают 453 теста, а не 432 (+12 в `protocol.test.ts`, +2 в `reference-sync.test.ts`, +7 в `products-page.test.tsx`). Набор Cargo — как в плане: 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107). Ни одно утверждение плана не ослаблено (проверило ревью каждой задачи), но тексты тестов задач 1–6 отличаются от плана добавками; ожидаемые числа в задачах 3–6 плана читать с поправкой +9, +14, +21 и +21.
- Ошибка плана про `null` в правке шаблона. Вступление задачи 2 и заголовок теста «refuse null where the host does not take it…» говорят, что хост отвергает `null` в `name`, `enabled` и `spec` тела `PUT /v1/office/templates/{id}`. Хост читает там `null` как «поле не прислано» и оставляет значение (`routes/templates.rs`, `update_template`: поля `Option` без `nullable`); `null` у `chzProductGroupCodes` расширяет шаблон на все категории, а `null` в `orgDefault` и `templates` мастера хост отвергает. Закреплённое поведение верно: схема отвергает `null` в трёх полях, сборщик его не шлёт. Docstring схемы, AGENTS «Protocol» и сообщение коммита говорят верно; заголовок теста исправила волна правок.
- D9 — по уточнению планировщика: «Загрузить заново» сразу перечитывает список товаров, а список шаблонов перечитывается при следующем открытии диалога (`staleTime` 0) без явного сброса кэша; тест закрепляет второе чтение. Ревью задачи 6 признало окно с кэшем при повторном открытии безвредным: гарантия — сам отказ D9, а не политика кэша. В режиме добавления то же предложение закрывает окно и теряет введённый товар (на хосте ничего не записано) — это вопрос владельцу, см. «Перенесено».
- Страница «Товары» листает своим `ProductsPager`, а не общим `Pager` из `@markiro/ui`: у общего кнопки размера `floor` (64 px) на всю ширину и нет параметра размера, а `packages/*` план не меняет; у страницы каталога облака тоже свой пейджер. Ревью задачи 4 это приняло; волна правок добавила `aria-live` подписи страницы и комментарий, почему общий не взят.
- Копии станции (задача 3): миграция, записи ленты, три сущности и `SYNC_SCHEMA_VERSION` 4 — как в плане; пять добавленных тестов закрывают столбцы upsert, которые не обновлялись на более новой ревизии, и `null` в шаблоне короба организации (иначе запись организации ушла бы в карантин). Тест на Rust закрепляет, что ограничения оболочки считают текст SQL и число значений, а не размер одного значения (`one_value_of_a_few_mebibytes_passes_the_limits`); путь через настоящий `invoke` WebView2 и мок-рантайм Tauri остаётся непроверенным (см. «Перенесено»).
- Текст о черновике в окне товара изменила волна правок: «Товар остаётся черновиком, пока не указаны товарная группа, вместимость короба и число коробов на паллете.» Код (`staysDraft`) не менялся — окно показывает строку, пока нет группы или любой из двух вместимостей, — а прежний текст плана («Без группы и вместимостей товар остаётся черновиком») читался как «нет и группы, и вместимостей». План ниже ещё цитирует прежний текст в шагах задачи 5 и в «Итоговой проверке»; верен текст в `ru.json`.
- Итоговый гейт Cargo шёл частями, как предписывает «Итоговая проверка плана»: `fmt` и `check --all-targets` чисто, `--no-run` без предупреждений, затем набор А в песочнице (19 наборов, 244 теста), набор Б вне песочницы (19 наборов, 209 тестов, в нём `hello`, `platform`, `no_secrets_in_logs`, `changes_stream`, `pairing`, `pairing_codes` и вся оболочка) и `--doc` (3 пустых набора); итог 41 набор и 453 теста, подсчёт скриптом по журналам. Каждый заново слинкованный тестовый двоичный файл стартует на этой машине около 35 с, поэтому гейт занимает больше часа.
- Ловушка для следующих планов: при мутационной проверке на Rust восстановленный файл нужно возвращать со свежей меткой времени, иначе Cargo берёт артефакт мутанта (находка исполнителя задачи 3).

**Волна правок итогового ревью** (`a67a5e796`, `5304f51ed`, `fbfa7cd4b`; ревью — «с правками», Critical 0, Important 0, шесть новых Minor F1–F7 и 26 разобранных очередью)

- Тесты и заголовки (`a67a5e796`): два утверждения для ветки дубликата в `templateFitsSlot` (мутанты «категории `null` — только слот организации» и «первый код списка» выживали); `productNameRule` и `printNameRule` в цикле одиночных суррогатов; `i18n.t("rules.productGroup")` (текст, который не выводит ни один тест); поиск по GTIN с двумя пробелами («4 600682 000013»); владелец GTIN у контрагента с двумя префиксами (`.some` вместо `.every`); очистка прежнего предупреждения при новой отправке; значение пункта «Не выбран»; архивный черновик в тестах страницы; заголовки (ошибочный про `null`, про отрицательное `dpi`, четыре потерявших точность, четвёртый — про `checkGtinOwner`); без приведения типов в тесте «whole bodies».
- Страница «Товары» (`5304f51ed`): при сбое сразу и товаров, и групп — одно предупреждение и одна кнопка «Повторить», которая перечитывает оба; `aria-live` у подписи страницы; текст о черновике.
- Документы (`fbfa7cd4b`): комментарий `toGtin14` (бросает `DomainError`), формулировки AGENTS и спецификации (пределы «как у хоста», причины отсутствия уникальности в копиях, строка о черновике, подсказка владельца GTIN «как `checkGtinOwner`, но действующие контрагенты первыми», короткие подписи отсутствующих идентификаторов, §5.5 про `gtinMatchesPrefix` и `labelTemplateSpecSchema`, «все схемы Zod каталога и сборщик каждого тела», время глагола «станция будет проверять», «схема разбирает фикстуру» и поздние порции).
- Повторное ревью волны одобрило её (28 пунктов из 29 закрыты, один — с оговоркой в заголовке теста): две оговорки, не мешавшие закрытию, — префикс GTIN «только сверяется для подсказки» (AGENTS и спецификация §4.3) и «когда не загрузились и товары, и группы, виден только сбой товаров» (AGENTS «Office pages») — закрыты коммитом `ea4cc54e1`. Неточный заголовок теста «Новый товар» и непривязанные `setFailure(null)` в диалогах контрагентов и линий оставлены.
- Проба итогового ревью (модель ленты хоста и четыре станции через настоящий `syncReferences` на `node:sqlite`, 40 прогонов по 300 шагов: 1 398 полных синхронизаций, 307 поздних порций, 26 233 страницы) сошлась к состоянию хоста везде; она не закоммичена (лежит вне репозитория), см. «Перенесено».
