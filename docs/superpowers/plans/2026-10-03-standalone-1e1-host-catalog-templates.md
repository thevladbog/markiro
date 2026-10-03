# План 1e1: хост — каталог: товарные группы ЧЗ, товары, шаблоны этикеток и их умолчания, типовые шаблоны мастера — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост ведёт каталог автономного продукта и отдаёт его станциям. Справочник товарных групп ЧЗ переносится из облака строка в строку; администратор и технолог заводят товары, шаблоны этикеток и их умолчания — организации и категорий; мастер первого запуска принимает типовые шаблоны, которые приложение строит функциями `@markiro/domain`. Лента изменений получает товары, шаблоны и умолчания категорий, запись организации — три её шаблона по умолчанию, а порции ленты ограничиваются и по байтам. Экраны каталога и шаблонов, копии на станции и мастер с типовыми шаблонами — планы 1e2 и 1e3; этот план готовит им API, данные, договор ленты и фикстуры.

**Architecture:**

- `host/migrations/0008_catalog.sql` — `chz_product_groups` (51 строка облачной миграции `0099`), `label_templates`, `products` с вычисляемым `status`, `category_template_defaults`, три столбца шаблонов по умолчанию у `org_profile`, индексы по `rev`.
- `host/src/routes/changes.rs` — сущности `products`, `label_templates`, `category_template_defaults` и шаблоны организации в её записи; порция кончается и по `MAX_PAGE_BYTES`.
- `host/src/routes/products.rs` (товарные группы и товары), `templates.rs` (шаблоны), `template_defaults.rs` (умолчания одним документом); `bootstrap.rs` — типовые шаблоны мастера.
- `host/src/templates.rs` — правило слота умолчания (`fits`), чьим умолчанием стоит шаблон (`usage`), отказ `template_is_default`.
- `host/src/auth.rs` — `require_catalog` и `require_catalog_in`: каталог пишут администратор и технолог.
- `host/src/validate.rs` — проверки GTIN-14, имён, вместимостей, макета (`spec`) и кодов категорий.
- `proto` — записи ленты, запросы и ответы каталога с фикстурами; `TemplatePurpose`, `ProductStatus`, `category_default_id`.

**Tech Stack:** Rust — axum 0.8.9, sqlx 0.8.6 (встроенная SQLite 3.46.0: вычисляемые столбцы, `json_each`, `json_type`, оператор `->`), tokio 1.53.1, serde, serde_json (без `preserve_order`). TypeScript не меняется.

**Спецификации:**

- Решения контроллера — `.superpowers/sdd/1e1-design.md`; где план их уточняет, ниже стоит «уточнение плана».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §2 решения 11–13, §4.3 — схема, §4.4 — лента, §4.5 — протокол, §4.6 — ошибки, §4.8 — роли, §4.9 — журнал, §4.10 — журнал процесса, §5.4–5.5 — что сделают станция и офис (планы 1e2, 1e3); этот план — хостовая часть строки 1e раздела 8.
- Планы 1c3, 1d1–1d4 и их разделы «Отклонения при исполнении»: правила записи, лента, журнал действий, общая поддержка тестов хоста.
- Облако, с которого сняты правила: `apps/api/src/modules/label-templates/{label-templates.service,box-label-template-eligibility,dto}.ts`, `apps/api/src/modules/products/{products.service,product-writer,dto,product-groups.service}.ts`, `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (типовые шаблоны), `packages/db/migrations/0099_chz_product_groups.sql`, `packages/db/migrations/0111_label_template_scope_and_defaults.sql`, `packages/domain/src/labels/{eligibility,model,defaults,duplicate,pallet-defaults}.ts`, спецификация `docs/superpowers/specs/2026-09-02-label-template-scope-and-defaults-design.md`.

## Global Constraints

**Решения контроллера и их уточнения (обязательные)**

1. Правила маркировки и макета — в `@markiro/domain` и интерфейсе (спецификация §2, решение 11). Хост проверяет вид, уникальность, ссылочную целостность, вычисляемый статус товара и отказ `template_is_default`; контрольную цифру GTIN и схему макета он не проверяет. `spec` хранится текстом JSON: объект не больше `MAX_SPEC_BYTES` = 262 144 байт (256 КБ) в компактной записи, ключи объектов — в порядке байтов (так пишет `serde_json` без `preserve_order`); интерфейс проверяет макет `labelTemplateSpecSchema`. Правило «шаблон подходит слоту умолчания» есть с двух сторон: `templates::fits` хоста и `isBoxLabelTemplateEligible`/`isPalletLabelTemplateEligible` домена; их держит одна фикстура `proto/fixtures/template-eligibility.json` — её читает тест хоста, план 1e2 прочитает её в Vitest.
2. Роли (спецификация §4.8): `GET` товарных групп, товаров, шаблонов и умолчаний — все роли офиса; запись — администратор и технолог (`editCatalog`). Ранняя проверка — `OfficeContext::require_catalog`, внутри каждой транзакции записи — `require_catalog_in` (сессия жива, пользователь активен, роль подходит по `auth::edits_catalog`, где у `match` нет ветки по умолчанию). Права на контрагентов, линии, операторов и устройства не меняются.
3. Конкурентность: `PUT` товара и шаблона несёт `expectedRev` и отвечает `stale_revision` с `details.currentRev`. Умолчания — один документ (`GET/PUT /v1/office/template-defaults`): три умолчания организации и все умолчания категорий; `PUT` заменяет документ целиком и несёт `expectedRev` документа. Ревизия документа — самая новая из `org_profile.rev`, ревизий строк `category_template_defaults` и надгробий снятых умолчаний категорий: каждое изменение умолчаний её поднимает. Уточнение плана: правка профиля организации (`PUT /v1/office/org`) тоже поднимает её, и запись умолчаний поверх старой ревизии после переименования организации получает `stale_revision` — принято ради одной ревизии без нового столбца. Запрос без изменений ничего не пишет.
4. Шаблоны (как облачный `label-templates.service.ts`). Назначение не меняется: у `PUT` нет поля `purpose`, присланное — `validation_failed` (`deny_unknown_fields`). `chzProductGroupCodes` — `null` (все категории) или непустой список без повторов из известных кодов, не длиннее 100. Слот умолчания берёт только включённый шаблон своего назначения (короб ← `box`, паллета ← `pallet`, дубликат ← `product_duplicate`), покрывающий категорию слота; слот организации — шаблон для всех категорий (`templates::fits`). Выключение шаблона и сужение его категорий отвергаются `conflict` с `constraint: template_is_default`, `organizationDefault` (bool) и `categoryDefaults` (коды по возрастанию), если шаблон — умолчание организации (оно обязано остаться включённым шаблоном для всех категорий) или умолчание категории, которую он перестал бы покрывать; `DELETE` — так же для любого умолчания. Удаление шаблона, который не умолчание: хост сам снимает ссылки товаров (`default_box_template_id`, `default_pallet_template_id` → `NULL`) в той же транзакции, с ревизией удаления — товар получает новую `rev` и едет по ленте; затем удаляет строку шаблона и пишет надгробие. `ON DELETE SET NULL` в схеме — страховка: он менял бы строки мимо ленты. Повторный `DELETE` после потерянного ответа находит надгробие и снова отвечает 204, неизвестный идентификатор — `not_found`.
5. Типовые шаблоны (рекомендация контроллера принята): признак `stock` ставит только мастер. Имя, назначение и макет типового шаблона не меняются, и он не удаляется — `conflict` с `constraint: stock_template`; выключить и сузить его можно (с той же проверкой умолчаний), копия — обычный `POST` его макета. `PUT` с его же именем и макетом (форма шлёт поля целиком) не отвергается. В облаке типовые шаблоны — обычные строки, их опознают по имени и правят; на хосте имя и макет закрыты, потому что мастер — единственный источник типовых шаблонов и вернуть испорченный макет нечем.
6. Лента (спецификация §4.4): новые сущности `products`, `label_templates`, `category_template_defaults`; запись `org_profile` получает `defaultBoxTemplateId`, `defaultPalletTemplateId`, `defaultDuplicateTemplateId` (`null`, если не заданы; запись старого хоста без них читается как `null`). Каталог доступа не даёт, поэтому признаки остаются признаками: архивный товар и выключенный шаблон едут с `archived` и `enabled` — станция хранит их для истории и не предлагает в выборе (облачного прецедента против нет). Надгробие пишут `DELETE` шаблона и снятое умолчание категории; товар надгробия не получает никогда — его архивируют. Ключ умолчания категории в ленте — `<код>:<назначение>` (`8:box`, `markiro_proto::category_default_id`, тот же текст строит SQL ленты). Умолчание категории, назначенное снова после снятия, снимает своё надгробие (`feed::restore`). Индексы по `rev`: `products_rev`, `label_templates_rev`, `category_template_defaults_rev`. `spec` едет как JSON, не как текст.
7. Порция ленты: не больше `limit` записей (по умолчанию 500, не больше 1000) и не больше `MAX_PAGE_BYTES` = 1 МиБ JSON записей — порция кончается перед ревизией, с которой перевалила бы границу. Ревизия больше любой из границ приходит целиком, если она в порции первая, — лента всегда продвигается. Байты считаются по `serde_json::to_vec` каждой записи, без обрамления ответа.
8. Товарные группы (спецификация §2, решение 12): 51 строка из `packages/db/migrations/0099_chz_product_groups.sql`, перенесённая миграцией `0008` строка в строку; только чтение (`GET /v1/office/product-groups`, все роли, по коду), в ленту не входит — как их получит станция, решает план 1e2. Тест `host/tests/product_groups.rs` разбирает облачный SQL-файл в репозитории и сравнивает строки; не фикстура: она была бы третьей копией, которая тоже может разойтись с облаком.
9. Товары. `gtin14` — 14 цифр ASCII после обрезки (только вид: контрольная цифра и префикс — `normalizeToGtin14` и `gtinMatchesPrefix` интерфейса); уникален среди неархивных (частичный уникальный индекс `products_active_gtin14`, `conflict` с `constraint: gtin14`), среди архивных повтор допустим. Товарная группа необязательна, но названная должна существовать. Имя — 1–200 символов, имя для печати — до 200 или пусто (как `printName` облака); `boxCapacity` — 1–100 000, `palletBoxCapacity` — 1–10 000 (уточнение плана: облачный DTO их не ограничивает, потолки — именованные константы, которые только не пускают опечатку), `shelfLifeDays` — 1–3650 (граница облачного DTO). `status` — вычисляемый столбец (`active` при группе и обеих вместимостях, иначе `draft`), его никто не шлёт. Архив — `archived` в `PUT`, удаления нет. Шаблоны товара по умолчанию (короб, паллета) — пожелания: хост проверяет, что шаблон есть и его назначение совпадает со слотом; включён ли он и покрывает ли группу товара, проверяют интерфейс при выборе и станция перед использованием. Уточнение плана: строже не нужно — в облаке шаблона на товар нет со спецификации 2026-09-02 (`products.default_label_template_id` остаётся неиспользуемым), зеркалить нечего, а строгая проверка при каждой записи товара не дала бы заархивировать товар, чей шаблон выключили позже. Вне плана 1e из облачного товара: фото (этапы 2a, 4), связь с Нацкаталогом и статусы ЧЗ, ЕГАИС, цена, контрагент по умолчанию, внешний код.
10. Мастер (`POST /v1/bootstrap`): необязательный список `templates` — старый мастер без него работает, `BootstrapRequest` по-прежнему `deny_unknown_fields`. Не больше `MAX_STOCK_TEMPLATES` = 32 (домен строит 20), у каждого имя, назначение и макет по правилам шаблона; хранятся включёнными, для всех категорий, с `stock`, в той же транзакции, что и остальное, — отказ ничего не создаёт. Уточнение плана: умолчание организации назначает флаг `orgDefault: true` на самом шаблоне, а не индекс и не ключ клиента — ссылаться на шаблон без идентификатора не нужно, и плохой ссылки не бывает; второй флаг того же назначения — `validation_failed` на `templates.{i}.orgDefault`.
11. Журнал действий (§4.9) — таблица ниже; `details` несут имена, коды и имена изменённых полей, изменённый `spec` — только имя в `changed`, без значения. Отказанная запись офиса ничего не пишет.
12. Ошибки: новых кодов нет — `validation_failed` (+ `details.field`), `conflict` (+ `constraint`: `gtin14`, `template_is_default`, `stock_template`), `not_found`, `stale_revision`, `forbidden`. Уточнение спецификации §4.6: `template_is_default` — ограничение `conflict`, а не отдельный код, и `gtin` называется `gtin14`.
13. Протокол: запросы — `deny_unknown_fields`, ответы терпят новые поля; у каждого нового типа `proto` есть фикстура, которую разбирает `proto/tests/fixtures.rs`; Zod и вебвью не меняются (план 1e2). `PROTOCOL_VERSION` не меняется: только добавления, `templates` мастера необязателен. Существующие фикстуры не меняются — Vitest сверяет `changes-response.json` и `bootstrap-request.json` со своими схемами через `toEqual`: новая запись организации закреплена в `changes-catalog.json`, мастер с шаблонами — в `bootstrap-request-templates.json`.

**Модель данных** (миграция `0008_catalog.sql`)

- `chz_product_groups(code INTEGER PRIMARY KEY, alias UNIQUE, name)` — 51 строка облачной `0099`.
- `label_templates(id, name, purpose, enabled, category_codes, spec, stock, rev)`: `purpose IN ('box', 'pallet', 'product_duplicate')`, `category_codes` — `NULL` или непустой JSON-массив, `spec` — JSON-объект не больше 262 144 байт; индекс `label_templates_rev`.
- `products(id, gtin14, name, print_name, chz_group_code, box_capacity, pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status, rev)`: ссылки на группу и шаблоны (`ON DELETE SET NULL`), `status GENERATED ALWAYS AS (…) VIRTUAL`; частичный уникальный индекс `products_active_gtin14` (`WHERE archived = 0`), индексы по ссылкам на шаблоны и `products_rev`. Потолки вместимостей и срока — только в `validate.rs` (CHECK держит `> 0`): их смене миграция не нужна.
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))` со ссылками на группу и шаблон; индексы по `template_id` и `rev`.
- `org_profile` + `default_box_template_id`, `default_pallet_template_id`, `default_duplicate_template_id` со ссылками на шаблон.

**Лента**

- Сущности и их `data`, точно:
  - `products` — `{ gtin14, name, printName, chzProductGroupCode, boxCapacity, palletBoxCapacity, shelfLifeDays, defaultBoxTemplateId, defaultPalletTemplateId, archived, status }`;
  - `label_templates` — `{ name, purpose, enabled, chzProductGroupCodes, stock, spec }`;
  - `category_template_defaults` — `id` `<code>:<purpose>`, `{ chzProductGroupCode, purpose, templateId }`;
  - `org_profile` — прежние поля и `defaultBoxTemplateId`, `defaultPalletTemplateId`, `defaultDuplicateTemplateId`.
- Порядок `(rev, entity, id, deleted DESC)`: внутри ревизии `category_template_defaults` < `label_templates` < `lines` < … < `org_profile` < `products`. Надгробие удалённого шаблона приходит раньше товаров, у которых удаление сняло ссылку, а шаблон может лежать в карантине станции, поэтому копии станции (план 1e2) не держат внешних ключей на шаблоны.

**Права** (спецификация §4.8)

- Товарные группы: `GET` — все роли; записи нет.
- Товары, шаблоны, умолчания: `GET` — все роли; `POST`, `PUT`, `DELETE` — администратор и технолог. Роль перечитывается на каждом запросе офиса (`OfficeContext`), каждая запись каталога перепроверяет её внутри транзакции (`require_catalog_in`). Отказ `forbidden` сейчас недостижим — каталог пишут обе роли; ветка нужна для будущей роли.

**Коды ошибок по маршрутам**

- `validation_failed` с `details.field`:
  - товары — `gtin14`, `name`, `printName`, `chzProductGroupCode`, `boxCapacity`, `palletBoxCapacity`, `shelfLifeDays`, `defaultBoxTemplateId`, `defaultPalletTemplateId`;
  - шаблоны — `name`, `chzProductGroupCodes`, `spec`;
  - умолчания — `defaultBoxTemplateId`, `defaultPalletTemplateId`, `defaultDuplicateTemplateId`, `categories.{i}` (слот назван дважды), `categories.{i}.chzProductGroupCode`, `categories.{i}.templateId`;
  - мастер — `templates`, `templates.{i}.name`, `templates.{i}.spec`, `templates.{i}.orgDefault`.
- Тело с лишним полем или значением не того типа (в том числе `purpose` в `PUT` шаблона, неизвестное назначение, отрицательное число) — `validation_failed` без `field`.
- `conflict` с `details.constraint`: `gtin14` — GTIN занят товаром в работе; `stock_template` — имя, макет или удаление типового шаблона; `template_is_default` — с `organizationDefault` и `categoryDefaults`.
- `not_found` — нет товара или шаблона; `GET/PUT /v1/office/template-defaults` до мастера — нет организации. Тело проверяется раньше поиска записи.

**Журнал действий** (§4.9, словарь `audit::actions`)

| Действие                   | `target_type`                | `details`                                                                                                                                                                                  |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `product.create`           | `product`                    | `{ gtin14, name }`                                                                                                                                                                         |
| `product.update`           | `product`                    | `update_details`: `gtin14`, `name`, `printName`, `chzProductGroupCode`, `boxCapacity`, `palletBoxCapacity`, `shelfLifeDays`, `defaultBoxTemplateId`, `defaultPalletTemplateId`, `archived` |
| `template.create`          | `template`                   | `{ name, purpose }`                                                                                                                                                                        |
| `template.update`          | `template`                   | `update_details_hiding`: `name`, `enabled`, `chzProductGroupCodes`; `spec` — только в `changed`                                                                                            |
| `template.delete`          | `template`                   | `{ name, purpose, productsCleared }`                                                                                                                                                       |
| `template_defaults.update` | `template_defaults` (id `1`) | `update_details`: `defaultBoxTemplateId`, `defaultPalletTemplateId`, `defaultDuplicateTemplateId`, `categories` (списки целиком)                                                           |
| `host.bootstrap`           | `office_user`                | прежние поля и `templateCount`                                                                                                                                                             |

- Исполнитель — офисный пользователь (`actor_kind = office_user`, `actor_id` — его id), результат `ok`; у мастера — устройство, как прежде. Тесты сверяют строку целиком: `actor_kind`, `actor_id`, `action`, `target_type`, `target_id`, `result` и разобранный `details`.

**Формы протокола** (фикстуры `proto/fixtures`)

- `ProductGroup { code, alias, name }` — `product-group.json`.
- `OfficeProduct { id, gtin14, name, printName, chzProductGroupCode, boxCapacity, palletBoxCapacity, shelfLifeDays, defaultBoxTemplateId, defaultPalletTemplateId, archived, status, rev }`; `ProductCreate` — те же поля без `id`, `archived`, `status` и `rev`, после `name` все необязательны; `ProductUpdate` — запись целиком с `archived` и `expectedRev` (поле, которого нет, очищается), как у контрагента.
- `LabelTemplateSummary { id, name, purpose, enabled, chzProductGroupCodes, stock, widthMm, heightMm, dpi, language, rev }` — четыре поля макета читаются из сохранённого `spec`, `null`, где значения нужного типа нет; `LabelTemplate { id, name, purpose, enabled, chzProductGroupCodes, stock, spec, rev }`; `LabelTemplateCreate { name, purpose, enabled, chzProductGroupCodes?, spec }`; `LabelTemplateUpdate { name?, enabled?, chzProductGroupCodes?: list | null, spec?, expectedRev }`.
- `TemplateDefaults { defaultBoxTemplateId, defaultPalletTemplateId, defaultDuplicateTemplateId, categories: CategoryTemplateDefault[], rev }` (категории — по коду, затем по назначению); `TemplateDefaultsUpdate { default…TemplateId?, categories: CategoryTemplateDefaultInput[], expectedRev }`.
- Записи ленты — `ProductRecord`, `LabelTemplateRecord`, `CategoryTemplateDefault`; `OrgRecord` + три `default…TemplateId`.
- `BootstrapRequest.templates?: StockTemplate[]`, `StockTemplate { name, purpose, spec, orgDefault? }`.
- `TemplatePurpose` (`box`, `pallet`, `product_duplicate`; порядок вариантов — порядок имён) и `ProductStatus` (`draft`, `active`) с `as_str` и `FromStr`, как `DeviceKind`; `category_default_id(code, purpose)`.

**Код и процесс**

- Новых крейтов нет; манифесты и lockfile не меняются. `serde_json` во всех сборках без `preserve_order`: ключи `spec` всегда в порядке байтов.
- Правила записей из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на транзакцию, коммит через `commit_with_revision`, пул не трогать при открытой транзакции записи, без изменений — без записи; `require_catalog_in` в каждой записи каталога.
- `apps/station`, `packages/*`, вебвью (`apps/standalone/src`, `apps/standalone/test`), оболочка (`src-tauri`), применённые миграции `0001`–`0007` и существующие фикстуры не меняются.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; на момент применения он встречается в файле один раз (план применён к копии репозитория по шагам). Правки внутри шага идут сверху вниз по файлу. Шаг 1 (тесты) применяется раньше шага 3 (реализация); в `validate.rs` и `proto/src/lib.rs`, где есть и то и другое, шаг 1 трогает только модуль `tests`.
- «Заменить содержимое … целиком» — файл пишется заново, ровно как в блоке. «Create» — новый файл.
- Код в блоках уже отформатирован `cargo fmt` и prettier; расхождение при проверке значит опечатку.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента.
- Блок импорта `use markiro_proto::{…}` в `proto/tests/fixtures.rs` меняется целиком: `cargo fmt` переливает весь список при каждом новом имени.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.
- `node_modules/.bin/prettier --check` на изменённые JSON и MD.
- `git diff --check`.

**Cargo и git**

- Cargo — с `--offline`. Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.
- Тесты, которые слушают 127.0.0.1, — только вне песочницы: `host/tests/hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, `changes_stream.rs` и все `src-tauri/tests/*.rs`. Поэтому `cargo test -p markiro-host` целиком и `--workspace` идут вне песочницы, а отдельные `--test products`, `--test templates` и т. п. — и в ней.
- `cargo test -p markiro-host` и `-p markiro-proto` не собирают оболочку. Для `cargo test --workspace` нужен `apps/standalone/dist`: план меняет только Rust, поэтому достаточно собранного раньше `dist` (иначе `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`).
- `host/tests/product_groups.rs` читает `packages/db/migrations/0099_chz_product_groups.sql` по пути от `CARGO_MANIFEST_DIR`: тест работает в полном репозитории (CI-задания `standalone-rust` и `standalone-windows-build` выгружают его целиком).
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.
- Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- Текст с кириллицей через инструмент правки иногда ложится буквальными `\uXXXX`: после правки проверяйте байты (`grep -n '\\u0' <файл>` ничего не находит).
- Проверка плана на копии: у двух копий репозитория с общим `CARGO_TARGET_DIR` cargo может взять сборку члена воркспейса из другой копии (хеш артефакта считается от относительного пути, а `git archive` оставляет файлам старые mtime) — после распаковки копии обновите mtime всех её файлов.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/host/migrations/0008_catalog.sql                                              задача 1
apps/standalone/host/src/routes/products.rs                                                   задачи 1, 3
apps/standalone/host/src/routes/mod.rs                                                       задачи 1, 4, 5
apps/standalone/host/src/server.rs                                                           задачи 1, 3–5
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                                    задачи 1–6
apps/standalone/host/tests/product_groups.rs, proto/fixtures/product-group.json              задача 1
apps/standalone/host/src/routes/changes.rs, host/tests/changes.rs                           задача 2
apps/standalone/proto/fixtures/changes-catalog.json                                          задача 2
apps/standalone/host/src/auth.rs, host/tests/support/app.rs                                  задача 3
apps/standalone/host/src/validate.rs                                                         задачи 3, 4
apps/standalone/host/src/audit.rs                                                            задачи 3–5
apps/standalone/host/tests/products.rs                                                       задача 3
apps/standalone/proto/fixtures/{office-product,product-create,product-update}.json            задача 3
apps/standalone/host/src/templates.rs                                                        задачи 4, 5
apps/standalone/host/src/lib.rs, host/src/routes/templates.rs, host/tests/templates.rs       задача 4
apps/standalone/proto/fixtures/{template-summary,label-template,template-create}.json        задача 4
apps/standalone/proto/fixtures/{template-update,template-eligibility,error-template-is-default}.json   задача 4
apps/standalone/host/src/routes/template_defaults.rs, host/tests/template_defaults.rs         задача 5
apps/standalone/proto/fixtures/template-defaults{,-update}.json                               задача 5
apps/standalone/host/src/routes/bootstrap.rs, host/tests/{bootstrap,no_secrets_in_logs}.rs   задача 6
apps/standalone/proto/fixtures/bootstrap-request-templates.json                              задача 6
apps/standalone/AGENTS.md                                                                     задачи 1–6
спецификация: §4.3 — задачи 1, 3–5; §4.4 — задача 2; §4.5 — задачи 2, 5, 6; §4.6 — задачи 3, 4; §4.9, §4.10, §8 — задача 6
```

Миграция одна и стоит в задаче 1 вместе со справочником групп: тесты ленты в задаче 2 пишут строки товаров и шаблонов напрямую, как тесты операторов плана 1d2, до маршрутов. Права каталога появляются в задаче 3 вместе с первым писателем — товарами: шаблонам (задача 4) они нужны так же, а удаление шаблона снимает ссылки товаров. Умолчания (задача 5) опираются на правило слота задачи 4. Мастер — последним: он проверяет шаблоны правилами задачи 4 и назначает умолчания организации; с ним же идёт проверка журнала процесса, потому что именно мастер с шаблонами первым роняет её расширенный тест.

---

### Task 1: Каталог в модели хоста — миграция 0008 и справочник товарных групп

Миграция создаёт всю модель плана: справочник товарных групп ЧЗ (51 строка облачной миграции `0099`, строка в строку), шаблоны этикеток, товары с вычисляемым `status`, умолчания категорий и три столбца шаблонов по умолчанию у `org_profile`, с индексами по `rev` для ленты, как `lines_rev` и `operators_rev`. Маршрут в задаче один — справочник групп: лента задачи 2 пишет строки напрямую, остальные маршруты приходят в задачах 3–5.

Справочник читают все роли (`GET /v1/office/product-groups`, по коду), не пишет никто, и в ленту станций он не входит: как станция получит группы, решает план 1e2 («Перенесено»). Тест `product_groups.rs` разбирает облачный SQL-файл и сравнивает его строки со строками хоста. Почему не фикстура: она была бы третьей копией, которая сама может отстать от облака, а облачный файл и есть источник.

**Files:**

- Create: `apps/standalone/host/migrations/0008_catalog.sql`, `apps/standalone/host/src/routes/products.rs`, `apps/standalone/proto/fixtures/product-group.json`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/product_groups.rs` (Create), `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` (новый раздел «Catalog and label templates»), спецификация §4.3

**Interfaces:**

- Consumes:
  - `OfficeContext` — `host/src/auth.rs`;
  - `TestApp`, `admin`, `Admin::{call_as, technologist}`, `request`, `empty`, `with_device` — `host/tests/support/app.rs`;
  - `round_trip` — `proto/tests/fixtures.rs`.
- Produces:
  - таблицы `chz_product_groups`, `label_templates`, `products`, `category_template_defaults`; столбцы `org_profile.default_box_template_id`, `default_pallet_template_id`, `default_duplicate_template_id`; индексы `label_templates_rev`, `products_active_gtin14`, `products_default_box_template`, `products_default_pallet_template`, `products_rev`, `category_template_defaults_template`, `category_template_defaults_rev`;
  - `pub struct ProductGroup { code: u32, alias: String, name: String }` — `proto/src/lib.rs`;
  - `pub async fn routes::products::list_product_groups(State<AppState>, OfficeContext) -> Result<Json<Vec<ProductGroup>>, ApiError>`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/product-group.json`:

<!-- prettier-ignore -->
```json
{ "code": 8, "alias": "milk", "name": "Молочная продукция" }
```

2. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

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
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
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
    PasswordSet, ProductGroup, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn a_product_group_fixture_round_trips() {
    let group: ProductGroup = round_trip("product-group.json");
    assert_eq!((group.code, group.alias.as_str()), (8, "milk"));
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

4. Create `apps/standalone/host/tests/product_groups.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, request, with_device, TestApp};

/// `(code, alias, name)` of every row the cloud's migration inserts: the one
/// source of the lookup, read here so the host's copy cannot drift from it.
fn cloud_groups() -> Vec<(i64, String, String)> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/db/migrations/0099_chz_product_groups.sql"
    );
    let sql = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    sql.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('('))
        .map(|line| {
            let row = line
                .trim_end_matches(',')
                .strip_prefix('(')
                .and_then(|row| row.strip_suffix(')'))
                .unwrap_or_else(|| panic!("not a row: {line}"));
            let (code, rest) = row.split_once(", '").unwrap();
            let (alias, name) = rest.split_once("', '").unwrap();
            let name = name.strip_suffix('\'').unwrap();
            (
                code.parse().unwrap(),
                alias.to_owned(),
                name.replace("''", "'"),
            )
        })
        .collect()
}

#[tokio::test]
async fn the_host_holds_the_clouds_product_groups_row_for_row() {
    let app = TestApp::new().await;
    let host: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    let cloud = cloud_groups();
    assert_eq!(cloud.len(), 51, "the cloud migration lists 51 groups");
    assert_eq!(host, cloud);
}

#[tokio::test]
async fn every_office_role_lists_the_product_groups_by_code() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let expected: Vec<Value> = cloud_groups()
        .into_iter()
        .map(|(code, alias, name)| json!({ "code": code, "alias": alias, "name": name }))
        .collect();
    for token in [admin.token.clone(), tech] {
        let (status, body) = admin
            .call_as(&token, "GET", "/v1/office/product-groups", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, Value::Array(expected.clone()));
    }
}

#[tokio::test]
async fn product_groups_need_an_office_session() {
    let admin = admin().await;
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/product-groups"),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test product_groups --offline`
Expected: FAIL — 3 теста из 3: `the_host_holds_the_clouds_product_groups_row_for_row` — `no such table: chz_product_groups`; два других получают `404` (маршрута нет) там, где ждут `200` и `401`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_proto::ProductGroup` ``.

- [ ] **Step 3: Миграция, тип протокола и маршрут справочника**

1. Create `apps/standalone/host/migrations/0008_catalog.sql`:

<!-- prettier-ignore -->
```sql
-- The catalog (spec §4.3). ЧЗ product groups are the cloud's static lookup,
-- copied row for row from packages/db/migrations/0099_chz_product_groups.sql
-- (`tests/product_groups.rs` compares the two); they are not in the station
-- feed. Products, label templates and the templates' category defaults ride
-- the feed; the organization's three default templates ride its record.
CREATE TABLE chz_product_groups (
  code INTEGER PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
INSERT INTO chz_product_groups (code, alias, name) VALUES
  (1, 'lp', 'Лёгкая промышленность'),
  (2, 'shoes', 'Обувные товары'),
  (3, 'tobacco', 'Табачная продукция'),
  (4, 'perfumery', 'Духи и туалетная вода'),
  (5, 'tires', 'Шины и покрышки пневматические резиновые новые'),
  (6, 'electronics', 'Фотокамеры (кроме кинокамер), фотовспышки и лампы-вспышки'),
  (7, 'pharma', 'Лекарственные препараты для медицинского применения'),
  (8, 'milk', 'Молочная продукция'),
  (9, 'bicycle', 'Велосипеды и велосипедные рамы'),
  (10, 'wheelchairs', 'Медицинские изделия'),
  (11, 'alcohol', 'Алкоголь'),
  (12, 'otp', 'Альтернативная табачная продукция'),
  (13, 'water', 'Упакованная вода'),
  (14, 'furs', 'Товары из натурального меха'),
  (15, 'beer', 'Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки'),
  (16, 'ncp', 'Никотиносодержащая продукция'),
  (17, 'bio', 'Специализированная пищевая продукция и БАД к пище'),
  (19, 'antiseptic', 'Антисептики и дезинфицирующие средства'),
  (20, 'petfood', 'Корма для животных'),
  (21, 'seafood', 'Морепродукты'),
  (22, 'nabeer', 'Безалкогольное пиво'),
  (23, 'softdrinks', 'Соковая продукция и безалкогольные напитки'),
  (25, 'meat', 'Мясные изделия'),
  (26, 'vetpharma', 'Ветеринарные препараты'),
  (27, 'toys', 'Игры и игрушки для детей'),
  (28, 'radio', 'Радиоэлектронная продукция'),
  (31, 'titan', 'Титановая металлопродукция'),
  (32, 'conserve', 'Консервированная продукция'),
  (33, 'vegetableoil', 'Растительные масла'),
  (34, 'opticfiber', 'Оптоволокно и оптоволоконная продукция'),
  (35, 'chemistry', 'Косметика, бытовая химия и товары личной гигиены'),
  (36, 'books', 'Печатная продукция'),
  (37, 'grocery', 'Бакалейная продукция'),
  (38, 'pharmaraw', 'Фармацевтическое сырьё, лекарственные средства'),
  (39, 'construction', 'Строительные материалы'),
  (40, 'fire', 'Пожарная безопасность'),
  (41, 'heater', 'Отопительные приборы'),
  (42, 'cableraw', 'Кабельно-проводниковая продукция'),
  (43, 'autofluids', 'Моторные масла'),
  (44, 'polymer', 'Полимерные трубы'),
  (45, 'sweets', 'Сладости и кондитерские изделия'),
  (48, 'carparts', 'Автозапчасти и комплектующие транспортных средств'),
  (49, 'furslp', 'Натуральный мех'),
  (50, 'nicotindev', 'Радиоэлектронная продукция. Электронные системы доставки никотина'),
  (51, 'gadgets', 'Радиоэлектронная продукция. Ноутбуки и смартфоны'),
  (52, 'frozen', 'Полуфабрикаты и замороженные продукты'),
  (53, 'fertilizers', 'Удобрения в потребительской упаковке'),
  (54, 'homeware', 'Товары для дома и интерьера'),
  (55, 'vetbio', 'Кормовые добавки'),
  (57, 'industrial', 'Промышленное оборудование'),
  (59, 'pyrotechnics', 'Пиротехнические изделия');

-- A label template. `spec` is the printable layout as compact JSON: the UI
-- checks it with `labelTemplateSpecSchema`, the host only keeps it an object
-- of at most 256 KB. `category_codes` is NULL for every category or a
-- non-empty JSON array of group codes. A stock template came from the wizard:
-- its name, purpose and spec never change, and it is never deleted.
CREATE TABLE label_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet', 'product_duplicate')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  category_codes TEXT CHECK (category_codes IS NULL OR (json_valid(category_codes)
    AND json_type(category_codes) = 'array' AND json_array_length(category_codes) > 0)),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'
    AND length(CAST(spec AS BLOB)) <= 262144),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE INDEX label_templates_rev ON label_templates (rev);

-- A product. `gtin14` is unique among the products in use, as
-- `products_tenant_gtin_unarchived_uq` in the cloud: an archived product keeps
-- its GTIN for history but no longer reserves it. The GS1 check digit is the
-- UI's rule. `status` is computed, as the cloud's `computeStatus`. A product
-- is archived, never deleted. Its default templates are preferences the
-- station checks before it uses them; deleting a template clears them here,
-- with a new revision for each product (`ON DELETE SET NULL` is the last line).
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  gtin14 TEXT NOT NULL CHECK (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  print_name TEXT CHECK (print_name IS NULL OR length(trim(print_name)) BETWEEN 1 AND 200),
  chz_group_code INTEGER REFERENCES chz_product_groups (code),
  box_capacity INTEGER CHECK (box_capacity IS NULL OR box_capacity > 0),
  pallet_box_capacity INTEGER CHECK (pallet_box_capacity IS NULL OR pallet_box_capacity > 0),
  shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  default_box_template_id TEXT REFERENCES label_templates (id) ON DELETE SET NULL,
  default_pallet_template_id TEXT REFERENCES label_templates (id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  status TEXT GENERATED ALWAYS AS (CASE WHEN chz_group_code IS NOT NULL
    AND box_capacity IS NOT NULL AND pallet_box_capacity IS NOT NULL
    THEN 'active' ELSE 'draft' END) VIRTUAL,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX products_active_gtin14 ON products (gtin14) WHERE archived = 0;
CREATE INDEX products_default_box_template ON products (default_box_template_id);
CREATE INDEX products_default_pallet_template ON products (default_pallet_template_id);
CREATE INDEX products_rev ON products (rev);

-- A category's default template of one purpose. The station resolves a
-- product's template as its category's default, then the organization's,
-- then none. Only an enabled template of the slot's purpose that covers the
-- category stands here (the host checks it on every write). Its feed id is
-- `<code>:<purpose>`; clearing one writes a tombstone.
CREATE TABLE category_template_defaults (
  chz_group_code INTEGER NOT NULL REFERENCES chz_product_groups (code),
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet', 'product_duplicate')),
  template_id TEXT NOT NULL REFERENCES label_templates (id),
  rev INTEGER NOT NULL,
  PRIMARY KEY (chz_group_code, purpose)
);
CREATE INDEX category_template_defaults_template ON category_template_defaults (template_id);
CREATE INDEX category_template_defaults_rev ON category_template_defaults (rev);

-- The organization's default template of each purpose: an enabled template
-- of that purpose for every category, or none.
ALTER TABLE org_profile ADD COLUMN default_box_template_id TEXT REFERENCES label_templates (id);
ALTER TABLE org_profile ADD COLUMN default_pallet_template_id TEXT REFERENCES label_templates (id);
ALTER TABLE org_profile ADD COLUMN default_duplicate_template_id TEXT REFERENCES label_templates (id);
```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// `GET /v1/office/badge-salt`: the site's badge salt, 16 bytes in standard
/// base64 with padding — the value the feed's `site` record carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSalt {
    pub badge_salt: Secret,
}

#[cfg(test)]
mod tests {
    use super::{DeviceKind, OfficeRole, UnknownVariant};
```

заменить на

<!-- prettier-ignore -->
```rust
/// `GET /v1/office/badge-salt`: the site's badge salt, 16 bytes in standard
/// base64 with padding — the value the feed's `site` record carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSalt {
    pub badge_salt: Secret,
}

/// A ЧЗ product group (`GET /v1/office/product-groups`): the cloud's static
/// lookup (spec §2, decision 12), read by every office role and not in the
/// station feed. Products and templates refer to `code`; `alias` is the
/// latin name True API takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductGroup {
    pub code: u32,
    pub alias: String,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::{DeviceKind, OfficeRole, UnknownVariant};
```

3. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod counterparties;
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod sscc;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod counterparties;
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
```

4. Create `apps/standalone/host/src/routes/products.rs`:

<!-- prettier-ignore -->
```rust
//! The catalog (spec §4.3). `GET /v1/office/product-groups` lists the ЧЗ
//! product groups: the cloud's static lookup, read by every office role and
//! written by nobody.

use axum::extract::State;
use axum::Json;
use markiro_proto::ProductGroup;

use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

/// `GET /v1/office/product-groups`: every group, by code.
pub async fn list_product_groups(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<ProductGroup>>, ApiError> {
    let rows: Vec<(u32, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(code, alias, name)| ProductGroup { code, alias, name })
            .collect(),
    ))
}
```

5. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/operators/{id}/badges/{badge_id}",
            delete(crate::routes::operators::revoke_badge),
        )
        .route(
            "/v1/office/badge-salt",
            get(crate::routes::operators::badge_salt),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
```

заменить на

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/operators/{id}/badges/{badge_id}",
            delete(crate::routes::operators::revoke_badge),
        )
        .route(
            "/v1/office/badge-salt",
            get(crate::routes::operators::badge_salt),
        )
        .route(
            "/v1/office/product-groups",
            get(crate::routes::products::list_product_groups),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test product_groups --offline`
Expected: PASS — 3 теста.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 4 модульных теста и 29 тестов фикстур (28 прежних и 1 новый).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
active operator is refused as ambiguous, never resolved to the first.
Precondition: the sign-in must not read the copies until the sync's
`hostGuard` is scoped to the pairing, not only to the host (the device id
stored in `sync_state` next to `host_id` and checked with it). Today a stale
page fetched before a `device_forget` passes the guard after a re-pair to the
same host, brings back a record a tombstone deleted (a turned-off operator, a
revoked badge) and rolls `last_rev` back until the next sync;
`notQuarantinedNewer` covers only the quarantine case.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
active operator is refused as ambiguous, never resolved to the first.
Precondition: the sign-in must not read the copies until the sync's
`hostGuard` is scoped to the pairing, not only to the host (the device id
stored in `sync_state` next to `host_id` and checked with it). Today a stale
page fetched before a `device_forget` passes the guard after a re-pair to the
same host, brings back a record a tombstone deleted (a turned-off operator, a
revoked badge) and rolls `last_rev` back until the next sync;
`notQuarantinedNewer` covers only the quarantine case.

## Catalog and label templates

The ЧЗ product groups are the cloud's static lookup: host migration `0008`
copies the 51 rows of `packages/db/migrations/0099_chz_product_groups.sql`,
and `host/tests/product_groups.rs` reads that file and compares the rows, so
the copies cannot drift. Every office role reads them
(`GET /v1/office/product-groups`, by code); nothing writes them, and they
are not in the station feed.

## Reference sync
```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
- `tombstones(entity, id, rev)` — удалённые справочные записи для ленты изменений.
- `site(id=1, badge_salt, box_block_size DEFAULT 2000, pallet_block_size DEFAULT 200, initialized_at, rev)`.
  Соль бейджей — 16 случайных байт, создаётся при инициализации.
- `org_profile(id=1, name, inn, gln, gs1_prefixes JSON, time_zone,
default_box_template_id, default_pallet_template_id, default_duplicate_template_id, rev)`.
  Проверки хоста: имя, ИНН, GLN и префиксы проверяет та же `validate::company`, что у
  контрагентов (правила — в их описании ниже), плюс часовой пояс — 1–64 символа из
  латинских букв, цифр и `/ _ - +`. Полную проверку IANA-имени делает интерфейс.
  Столбцы шаблонов по умолчанию добавляются миграцией плана 1e вместе с таблицей
  шаблонов.
- `counterparties(id, name, inn, gln, gs1_prefixes JSON, archived, rev)`. Проверки
  хоста — как у профиля организации (`validate::company`): имя 1–200 символов,
  ИНН 10 или 12 цифр либо пусто, GLN 13 цифр, не больше 10 префиксов по 4–12 цифр.
  Уникальности нет; архивирование — `archived`, удаления нет; в ленту станций не
  входят.
- `sscc_counters(issuer_prefix, extension, next_serial, rev, PRIMARY KEY(issuer_prefix, extension))`,
  где `extension` 0 — короб, 1 — паллета, как в облаке. На этапе 1 счётчик можно
  только сдвинуть вперёд (`sscc_below_floor`); проверки активных смен и выданных
```

заменить на

<!-- prettier-ignore -->
```text
- `tombstones(entity, id, rev)` — удалённые справочные записи для ленты изменений.
- `site(id=1, badge_salt, box_block_size DEFAULT 2000, pallet_block_size DEFAULT 200, initialized_at, rev)`.
  Соль бейджей — 16 случайных байт, создаётся при инициализации.
- `org_profile(id=1, name, inn, gln, gs1_prefixes JSON, time_zone,
default_box_template_id, default_pallet_template_id, default_duplicate_template_id, rev)`.
  Проверки хоста: имя, ИНН, GLN и префиксы проверяет та же `validate::company`, что у
  контрагентов (правила — в их описании ниже), плюс часовой пояс — 1–64 символа из
  латинских букв, цифр и `/ _ - +`. Полную проверку IANA-имени делает интерфейс.
  Столбцы шаблонов по умолчанию добавила миграция хоста `0008` (план 1e1) вместе с
  таблицей шаблонов: у каждого назначения — включённый шаблон этого назначения для
  всех категорий или пусто (правила — у `category_template_defaults` ниже).
- `counterparties(id, name, inn, gln, gs1_prefixes JSON, archived, rev)`. Проверки
  хоста — как у профиля организации (`validate::company`): имя 1–200 символов,
  ИНН 10 или 12 цифр либо пусто, GLN 13 цифр, не больше 10 префиксов по 4–12 цифр.
  Уникальности нет; архивирование — `archived`, удаления нет; в ленту станций не
  входят.
- `sscc_counters(issuer_prefix, extension, next_serial, rev, PRIMARY KEY(issuer_prefix, extension))`,
  где `extension` 0 — короб, 1 — паллета, как в облаке. На этапе 1 счётчик можно
  только сдвинуть вперёд (`sscc_below_floor`); проверки активных смен и выданных
```

3. Там же фрагмент

<!-- prettier-ignore -->
```text
  (`GET /v1/office/badge-salt`) и ровно 100 000 итераций, как `hashBadgeWithSalt`
  облака: с другим числом итераций копия бейджа прошла бы мимо индекса. Число
  пишется без ведущего нуля: `parse_phc` отвергает `0100000`, иначе тот же код
  дал бы вторую строку, а индекс сравнивает текст. Повтор — `conflict` с
  `constraint: badge`. Подпись (`label`) — до 100 символов или пусто.
  Отзыв — `DELETE …/badges/{badgeId}`: `revoked_at` и надгробие; повторный отзыв
  ничего не меняет.
- `chz_product_groups(code PRIMARY KEY, alias UNIQUE, name)` — 51 строка из облачной
  миграции `0099`.
- `products(id, gtin14 CHECK(length=14 AND цифры), name, print_name, chz_group_code REFERENCES chz_product_groups, box_capacity, pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status GENERATED ALWAYS AS (CASE WHEN chz_group_code IS NOT NULL AND box_capacity IS NOT NULL AND pallet_box_capacity IS NOT NULL THEN 'active' ELSE 'draft' END) VIRTUAL, rev)`;
  частичный уникальный индекс `gtin14` среди неархивных (как `products_tenant_gtin_unarchived_uq`).
  Ссылки на шаблоны — `ON DELETE SET NULL`.
- `label_templates(id, name, purpose CHECK(purpose IN ('box','pallet','product_duplicate')), enabled, category_codes JSON, spec JSON, stock, rev)`;
  `spec` хранится как текст JSON до 256 КБ, его схему проверяет интерфейс
  (`labelTemplateSpecSchema`).
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))`.
  Хост не даёт удалить или выключить шаблон, который стоит по умолчанию у
```

заменить на

<!-- prettier-ignore -->
```text
  (`GET /v1/office/badge-salt`) и ровно 100 000 итераций, как `hashBadgeWithSalt`
  облака: с другим числом итераций копия бейджа прошла бы мимо индекса. Число
  пишется без ведущего нуля: `parse_phc` отвергает `0100000`, иначе тот же код
  дал бы вторую строку, а индекс сравнивает текст. Повтор — `conflict` с
  `constraint: badge`. Подпись (`label`) — до 100 символов или пусто.
  Отзыв — `DELETE …/badges/{badgeId}`: `revoked_at` и надгробие; повторный отзыв
  ничего не меняет.
- `chz_product_groups(code PRIMARY KEY, alias UNIQUE, name)` — 51 строка из облачной
  миграции `0099`, перенесённая миграцией хоста `0008` строка в строку; тест
  `host/tests/product_groups.rs` читает облачный файл и сверяет строки, поэтому
  копии не разойдутся. Читают все роли (`GET /v1/office/product-groups`, по коду),
  не пишет никто; в ленту станций справочник не входит.
- `products(id, gtin14 CHECK(length=14 AND цифры), name, print_name, chz_group_code REFERENCES chz_product_groups, box_capacity, pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status GENERATED ALWAYS AS (CASE WHEN chz_group_code IS NOT NULL AND box_capacity IS NOT NULL AND pallet_box_capacity IS NOT NULL THEN 'active' ELSE 'draft' END) VIRTUAL, rev)`;
  частичный уникальный индекс `gtin14` среди неархивных (как `products_tenant_gtin_unarchived_uq`).
  Ссылки на шаблоны — `ON DELETE SET NULL`.
- `label_templates(id, name, purpose CHECK(purpose IN ('box','pallet','product_duplicate')), enabled, category_codes JSON, spec JSON, stock, rev)`;
  `spec` хранится как текст JSON до 256 КБ, его схему проверяет интерфейс
  (`labelTemplateSpecSchema`).
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))`.
  Хост не даёт удалить или выключить шаблон, который стоит по умолчанию у
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/product-group.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline`
Expected: PASS — 246 тестов (до плана 242: хост 210, `proto` 32).

```bash
git add apps/standalone/host/migrations/0008_catalog.sql apps/standalone/host/src/routes/products.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/product_groups.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/product-group.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): каталог в модели хоста — миграция 0008 и справочник товарных групп ЧЗ" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Каталог в ленте — товары, шаблоны, умолчания категорий, шаблоны организации; порции по байтам

Лента `GET /v1/changes` получает три сущности: `products` и `label_templates` (с архивными и выключенными записями, с их признаками) и `category_template_defaults` с ключом `<код>:<назначение>`. Запись `org_profile` получает три шаблона по умолчанию. Надгробия этих сущностей — общий механизм (`tombstones`, `feed`); их пишут маршруты задач 4 и 5.

Порция теперь кончается и по байтам: перед ревизией, с которой JSON её записей перевалил бы за `MAX_PAGE_BYTES` (1 МиБ). `spec` шаблона бывает до 256 КБ, и 500 шаблонов по счёту дали бы порцию в сотню мегабайт. Ревизия больше границы приходит целиком, если она в порции первая, — лента продвигается всегда. Тесты пишут строки напрямую (маршрутов ещё нет), как тесты операторов плана 1d2.

Существующие фикстуры не меняются: Vitest сверяет запись организации из `changes-response.json` со своей схемой через `toEqual`, а схема вебвью (`z.object`) новых полей до плана 1e2 не знает. Новая запись организации закреплена в `changes-catalog.json`; запись без трёх полей (старый хост) читается как `null`, это проверяет тест `proto`. Прежний тест ленты после мастера сверяет запись организации с тремя `null`.

**Files:**

- Create: `apps/standalone/proto/fixtures/changes-catalog.json`
- Modify: `apps/standalone/host/src/routes/changes.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/changes.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/proto/src/lib.rs` (модуль `tests`)
- Modify: `apps/standalone/AGENTS.md` («Change feed»), спецификация §4.4, §4.5

**Interfaces:**

- Consumes:
  - `FEED_KEYS`, `record`, `page`, `Page`, `item` — `host/src/routes/changes.rs`;
  - `parse_variant`, `UnknownVariant` — `proto/src/lib.rs`;
  - `TestApp`, `pair_device`, `bootstrap` — `host/tests/support/app.rs`; `changes`, `keys`, `add_lines` — `host/tests/changes.rs`.
- Produces:
  - `pub const MAX_PAGE_BYTES: usize = 1024 * 1024` — `host/src/routes/changes.rs`;
  - `entities::{PRODUCTS, LABEL_TEMPLATES, CATEGORY_TEMPLATE_DEFAULTS}`, `pub fn category_default_id(chz_product_group_code: u32, purpose: TemplatePurpose) -> String`;
  - `pub enum TemplatePurpose { Box, Pallet, ProductDuplicate }` и `pub enum ProductStatus { Draft, Active }` с `as_str` и `FromStr`;
  - `ProductRecord`, `LabelTemplateRecord`, `CategoryTemplateDefault { chz_product_group_code: u32, purpose, template_id }`; у `OrgRecord` — `default_box_template_id`, `default_pallet_template_id`, `default_duplicate_template_id: Option<String>`;
  - фикстура `proto/fixtures/changes-catalog.json`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/changes-catalog.json`:

<!-- prettier-ignore -->
```json
{
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "rev": 67,
  "hasMore": false,
  "items": [
    {
      "entity": "label_templates",
      "id": "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
      "rev": 61,
      "deleted": false,
      "data": {
        "name": "Коробка 58×40",
        "purpose": "box",
        "enabled": true,
        "chzProductGroupCodes": null,
        "stock": true,
        "spec": {
          "widthMm": 58,
          "heightMm": 40,
          "dpi": 203,
          "language": "zpl",
          "elements": [
            {
              "kind": "field",
              "id": "name",
              "xMm": 2,
              "yMm": 2,
              "field": "product.name",
              "fontSizePt": 9
            },
            {
              "kind": "barcode",
              "id": "sscc",
              "xMm": 2,
              "yMm": 12,
              "format": "code128",
              "data": "sscc",
              "sizeMm": 14
            }
          ]
        }
      }
    },
    {
      "entity": "label_templates",
      "id": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      "rev": 62,
      "deleted": false,
      "data": {
        "name": "Молоко 58×40",
        "purpose": "box",
        "enabled": true,
        "chzProductGroupCodes": [8],
        "stock": false,
        "spec": {
          "widthMm": 58,
          "heightMm": 40,
          "dpi": 203,
          "language": "tspl",
          "elements": [
            {
              "kind": "field",
              "id": "name",
              "xMm": 2,
              "yMm": 2,
              "field": "product.printName",
              "fontSizePt": 10
            }
          ]
        }
      }
    },
    {
      "entity": "org_profile",
      "id": "1",
      "rev": 63,
      "deleted": false,
      "data": {
        "name": "ООО «Атолл»",
        "inn": null,
        "gln": "4600682000013",
        "gs1Prefixes": ["4600682"],
        "timeZone": "Europe/Moscow",
        "defaultBoxTemplateId": "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
        "defaultPalletTemplateId": null,
        "defaultDuplicateTemplateId": null
      }
    },
    {
      "entity": "category_template_defaults",
      "id": "8:box",
      "rev": 64,
      "deleted": false,
      "data": {
        "chzProductGroupCode": 8,
        "purpose": "box",
        "templateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d"
      }
    },
    {
      "entity": "products",
      "id": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
      "rev": 65,
      "deleted": false,
      "data": {
        "gtin14": "04600682000013",
        "name": "Молоко 3,2% 0,9 л",
        "printName": "Молоко 3,2%",
        "chzProductGroupCode": 8,
        "boxCapacity": 12,
        "palletBoxCapacity": 40,
        "shelfLifeDays": 10,
        "defaultBoxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
        "defaultPalletTemplateId": null,
        "archived": false,
        "status": "active"
      }
    },
    {
      "entity": "products",
      "id": "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
      "rev": 66,
      "deleted": false,
      "data": {
        "gtin14": "04600682000020",
        "name": "Кефир 1% 0,9 л",
        "printName": null,
        "chzProductGroupCode": null,
        "boxCapacity": null,
        "palletBoxCapacity": null,
        "shelfLifeDays": null,
        "defaultBoxTemplateId": null,
        "defaultPalletTemplateId": null,
        "archived": true,
        "status": "draft"
      }
    },
    { "entity": "category_template_defaults", "id": "15:pallet", "rev": 67, "deleted": true },
    {
      "entity": "label_templates",
      "id": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      "rev": 67,
      "deleted": true
    }
  ]
}
```

2. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

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
    PasswordSet, ProductGroup, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope,
    LabelTemplateRecord, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate,
    OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord,
    OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode,
    PairingCodeRequest, PasswordChange, PasswordSet, ProductGroup, ProductRecord, ProductStatus,
    SiteRecord, SsccCounterUpdate, SsccState, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let assign: DeviceUpdate =
        serde_json::from_value(serde_json::json!({ "lineId": line })).unwrap();
    assert_eq!(assign.line_id, Some(Some(line.to_owned())));
    let mut value = fixture("device-update.json");
    value["kind"] = Value::String("office".into());
    assert!(serde_json::from_value::<DeviceUpdate>(value).is_err());
}

#[test]
fn a_product_group_fixture_round_trips() {
    let group: ProductGroup = round_trip("product-group.json");
    assert_eq!((group.code, group.alias.as_str()), (8, "milk"));
}
```

заменить на

<!-- prettier-ignore -->
```rust
    let assign: DeviceUpdate =
        serde_json::from_value(serde_json::json!({ "lineId": line })).unwrap();
    assert_eq!(assign.line_id, Some(Some(line.to_owned())));
    let mut value = fixture("device-update.json");
    value["kind"] = Value::String("office".into());
    assert!(serde_json::from_value::<DeviceUpdate>(value).is_err());
}

/// `value` read as `T` and written back unchanged: the typed record keeps
/// every field the feed sent.
fn typed<T: DeserializeOwned + Serialize>(value: &Value) -> T {
    let typed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(&serde_json::to_value(&typed).unwrap(), value);
    typed
}

#[test]
fn the_catalog_feed_fixture_round_trips_with_typed_records() {
    let changes: ChangesResponse = round_trip("changes-catalog.json");
    assert_eq!(changes.items.len(), 8);
    let data = |index: usize| changes.items[index].data.clone().expect("a live record");
    let id = |index: usize| changes.items[index].id.as_str();

    let stock: LabelTemplateRecord = typed(&data(0));
    assert!(stock.stock && stock.enabled);
    assert_eq!(stock.chz_product_group_codes, None);
    let milk: LabelTemplateRecord = typed(&data(1));
    assert_eq!(
        (milk.purpose, milk.chz_product_group_codes),
        (TemplatePurpose::Box, Some(vec![8]))
    );
    // The organization's box default is the stock template, for every category.
    let org: OrgRecord = typed(&data(2));
    assert_eq!(org.default_box_template_id.as_deref(), Some(id(0)));
    assert_eq!(org.default_pallet_template_id, None);
    // A category default's id is its slot.
    let default: CategoryTemplateDefault = typed(&data(3));
    assert_eq!(
        id(3),
        category_default_id(default.chz_product_group_code, default.purpose)
    );
    assert_eq!(default.template_id, id(1));
    let product: ProductRecord = typed(&data(4));
    assert_eq!(
        (product.status, product.default_box_template_id.as_deref()),
        (ProductStatus::Active, Some(id(1)))
    );
    // An archived product rides the feed with its flag.
    let archived: ProductRecord = typed(&data(5));
    assert_eq!(
        (archived.archived, archived.status),
        (true, ProductStatus::Draft)
    );
    assert!(changes.items[6..]
        .iter()
        .all(|item| item.deleted && item.data.is_none()));

    // An organization record from before plan 1e1 reads as no defaults.
    let older: OrgRecord =
        serde_json::from_value(fixture("changes-response.json")["items"][1]["data"].clone())
            .unwrap();
    assert_eq!(
        (
            older.default_box_template_id,
            older.default_pallet_template_id,
            older.default_duplicate_template_id
        ),
        (None, None, None)
    );
}

#[test]
fn a_product_group_fixture_round_trips() {
    let group: ProductGroup = round_trip("product-group.json");
    assert_eq!((group.code, group.alias.as_str()), (8, "milk"));
}
```

4. В `apps/standalone/host/tests/changes.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let (status, body) = changes(&app, &key, "?since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut expected: Vec<Value> = lines
        .iter()
        .map(|(id, name)| {
            json!({ "entity": "lines", "id": id, "rev": 1, "deleted": false, "data": { "name": name, "archived": false } })
        })
        .collect();
    expected.push(json!({
        "entity": "org_profile", "id": "1", "rev": 1, "deleted": false,
        "data": { "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow" }
    }));
    expected.push(json!({
        "entity": "site", "id": "1", "rev": 1, "deleted": false,
        "data": { "badgeSalt": STANDARD.encode(&salt), "boxBlockSize": 2000, "palletBlockSize": 200 }
    }));
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 1, "hasMore": false, "items": expected })
```

заменить на

<!-- prettier-ignore -->
```rust
    let (status, body) = changes(&app, &key, "?since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut expected: Vec<Value> = lines
        .iter()
        .map(|(id, name)| {
            json!({ "entity": "lines", "id": id, "rev": 1, "deleted": false, "data": { "name": name, "archived": false } })
        })
        .collect();
    // A wizard without stock templates leaves the three defaults unset.
    expected.push(json!({
        "entity": "org_profile", "id": "1", "rev": 1, "deleted": false,
        "data": {
            "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow",
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null, "defaultDuplicateTemplateId": null
        }
    }));
    expected.push(json!({
        "entity": "site", "id": "1", "rev": 1, "deleted": false,
        "data": { "badgeSalt": STANDARD.encode(&salt), "boxBlockSize": 2000, "palletBlockSize": 200 }
    }));
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 1, "hasMore": false, "items": expected })
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation()),
        "{error}"
    );
    // A revoked badge frees its code for another operator.
    revoke_badge(&app, &badge).await;
    insert_badge(&app, &second, BADGE_PHC).await.unwrap();
}
```

заменить на

<!-- prettier-ignore -->
```rust
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation()),
        "{error}"
    );
    // A revoked badge frees its code for another operator.
    revoke_badge(&app, &badge).await;
    insert_badge(&app, &second, BADGE_PHC).await.unwrap();
}

/// A small layout, stored as the host stores a spec: compact JSON.
const SPEC: &str = r#"{"dpi":203,"elements":[],"heightMm":40,"language":"zpl","widthMm":58}"#;

/// Items in the feed's order inside one revision: by entity, then by id.
fn in_feed_order(mut items: Vec<Value>) -> Value {
    items.sort_by(|a, b| {
        (a["entity"].as_str(), a["id"].as_str()).cmp(&(b["entity"].as_str(), b["id"].as_str()))
    });
    Value::Array(items)
}

#[tokio::test]
async fn catalog_records_ride_the_feed_with_their_flags() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let universal = uuid::Uuid::new_v4().to_string();
    let milk = uuid::Uuid::new_v4().to_string();
    let active = uuid::Uuid::new_v4().to_string();
    let archived = uuid::Uuid::new_v4().to_string();
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    for (id, name, enabled, codes, stock) in [
        (&universal, "Коробка 58×40", true, None, true),
        (&milk, "Молоко 58×40", false, Some("[8]"), false),
    ] {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, 'box', ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(enabled)
        .bind(codes)
        .bind(SPEC)
        .bind(stock)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE org_profile SET default_box_template_id = ?, rev = ? WHERE id = 1")
        .bind(&universal)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
         VALUES (8, 'box', ?, ?)",
    )
    .bind(&universal)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
         pallet_box_capacity, shelf_life_days, default_box_template_id, archived, rev) \
         VALUES (?, '04600682000013', 'Молоко 3,2% 0,9 л', 'Молоко 3,2%', 8, 12, 40, 10, ?, 0, ?)",
    )
    .bind(&active)
    .bind(&milk)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, archived, rev) \
         VALUES (?, '04600682000020', 'Кефир 1% 0,9 л', 1, ?)",
    )
    .bind(&archived)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let spec: Value = serde_json::from_str(SPEC).unwrap();
    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"],
        in_feed_order(vec![
            json!({
                "entity": "label_templates", "id": universal, "rev": rev, "deleted": false,
                "data": { "name": "Коробка 58×40", "purpose": "box", "enabled": true, "chzProductGroupCodes": null, "stock": true, "spec": spec }
            }),
            // A disabled template stays, with its flag.
            json!({
                "entity": "label_templates", "id": milk, "rev": rev, "deleted": false,
                "data": { "name": "Молоко 58×40", "purpose": "box", "enabled": false, "chzProductGroupCodes": [8], "stock": false, "spec": spec }
            }),
            json!({
                "entity": "org_profile", "id": "1", "rev": rev, "deleted": false,
                "data": {
                    "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow",
                    "defaultBoxTemplateId": universal, "defaultPalletTemplateId": null, "defaultDuplicateTemplateId": null
                }
            }),
            json!({
                "entity": "category_template_defaults", "id": "8:box", "rev": rev, "deleted": false,
                "data": { "chzProductGroupCode": 8, "purpose": "box", "templateId": universal }
            }),
            json!({
                "entity": "products", "id": active, "rev": rev, "deleted": false,
                "data": {
                    "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л", "printName": "Молоко 3,2%",
                    "chzProductGroupCode": 8, "boxCapacity": 12, "palletBoxCapacity": 40, "shelfLifeDays": 10,
                    "defaultBoxTemplateId": milk, "defaultPalletTemplateId": null, "archived": false, "status": "active"
                }
            }),
            // An archived product stays, with its flag; without a group and
            // capacities it is a draft.
            json!({
                "entity": "products", "id": archived, "rev": rev, "deleted": false,
                "data": {
                    "gtin14": "04600682000020", "name": "Кефир 1% 0,9 л", "printName": null,
                    "chzProductGroupCode": null, "boxCapacity": null, "palletBoxCapacity": null, "shelfLifeDays": null,
                    "defaultBoxTemplateId": null, "defaultPalletTemplateId": null, "archived": true, "status": "draft"
                }
            }),
        ])
    );
}

/// A spec of exactly `bytes` bytes of compact JSON.
fn spec_of(bytes: usize) -> String {
    format!(r#"{{"filler":"{}"}}"#, "x".repeat(bytes - 13))
}

/// Insert templates with the given specs in one transaction at a new
/// revision; returns their ids, sorted as the feed sorts them, and the
/// revision.
async fn add_templates(app: &TestApp, specs: &[String]) -> (Vec<String>, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let mut ids = Vec::new();
    for (index, spec) in specs.iter().enumerate() {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, spec, rev) \
             VALUES (?, ?, 'box', 1, ?, ?)",
        )
        .bind(&id)
        .bind(format!("Шаблон {index}"))
        .bind(spec)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids.sort();
    (ids, rev)
}

/// Five templates of 250 000 bytes each, one revision apiece: four fit in
/// a page of `MAX_PAGE_BYTES`, the fifth would pass it and waits for the
/// next page, although the count limit would take all five.
#[tokio::test]
async fn a_page_ends_before_the_revision_that_would_pass_the_byte_budget() {
    assert_eq!(markiro_host::routes::changes::MAX_PAGE_BYTES, 1024 * 1024);
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let mut added = Vec::new();
    for _ in 0..5 {
        let (ids, rev) = add_templates(&app, &[spec_of(250_000)]).await;
        added.push(("label_templates".to_owned(), ids[0].clone(), rev));
    }

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(keys(&body), added[..4].to_vec());
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(added[3].2), json!(true))
    );
    let (_, body) = changes(&app, &key, &format!("?since={}", added[3].2)).await;
    assert_eq!(keys(&body), added[4..].to_vec());
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(added[4].2), json!(false))
    );
}

/// A revision larger than the budget is never split: it waits behind a
/// smaller one, then comes whole as a page of its own.
#[tokio::test]
async fn a_revision_larger_than_the_byte_budget_still_comes_whole() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (line, line_rev) = add_lines(&app, &["Линия A"]).await;
    let (templates, big) = add_templates(&app, &vec![spec_of(250_000); 5]).await;

    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        keys(&body),
        vec![("lines".to_owned(), line[0].clone(), line_rev)]
    );
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(line_rev), json!(true))
    );
    let (_, body) = changes(&app, &key, &format!("?since={line_rev}")).await;
    assert_eq!(
        keys(&body),
        templates
            .iter()
            .map(|id| ("label_templates".to_owned(), id.clone(), big))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(big), json!(false))
    );
}
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::{DeviceKind, OfficeRole, UnknownVariant};

    /// Every `DeviceKind`. The `match` has no wildcard arm, so a new variant
    /// does not compile until it is listed here; the round trip below then
    /// checks its `as_str` name against serde and `FromStr`.
    fn device_kinds() -> Vec<DeviceKind> {
        let kinds = vec![
            DeviceKind::Station,
            DeviceKind::Office,
```

заменить на

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
    fn template_purposes() -> Vec<TemplatePurpose> {
        let purposes = vec![
            TemplatePurpose::Box,
            TemplatePurpose::Pallet,
            TemplatePurpose::ProductDuplicate,
        ];
        for purpose in &purposes {
            match purpose {
                TemplatePurpose::Box
                | TemplatePurpose::Pallet
                | TemplatePurpose::ProductDuplicate => {}
            }
        }
        purposes
    }

    /// Every `ProductStatus`, listed the same way.
    fn product_statuses() -> Vec<ProductStatus> {
        let statuses = vec![ProductStatus::Draft, ProductStatus::Active];
        for status in &statuses {
            match status {
                ProductStatus::Draft | ProductStatus::Active => {}
            }
        }
        statuses
    }

    /// The catalog's stored names parse back like the others, and purposes
    /// sort as their names do, so a list the host orders in SQL by `purpose`
    /// and one ordered in Rust agree.
    #[test]
    fn catalog_names_parse_back_and_purposes_sort_as_their_names() {
        for purpose in template_purposes() {
            assert_eq!(purpose.as_str().parse::<TemplatePurpose>(), Ok(purpose));
            assert_eq!(serde_json::to_value(purpose).unwrap(), purpose.as_str());
        }
        for status in product_statuses() {
            assert_eq!(status.as_str().parse::<ProductStatus>(), Ok(status));
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
        let mut by_name: Vec<TemplatePurpose> = template_purposes().into_iter().rev().collect();
        by_name.sort_by_key(|purpose| purpose.as_str());
        let mut by_order: Vec<TemplatePurpose> = template_purposes().into_iter().rev().collect();
        by_order.sort();
        assert_eq!(by_name, by_order);
        assert_eq!(by_order, template_purposes());
        assert_eq!(
            "Box".parse::<TemplatePurpose>().unwrap_err().to_string(),
            "unknown template purpose \"Box\""
        );
        assert_eq!(
            category_default_id(8, TemplatePurpose::ProductDuplicate),
            "8:product_duplicate"
        );
    }

    /// Every `DeviceKind`. The `match` has no wildcard arm, so a new variant
    /// does not compile until it is listed here; the round trip below then
    /// checks its `as_str` name against serde and `FromStr`.
    fn device_kinds() -> Vec<DeviceKind> {
        let kinds = vec![
            DeviceKind::Station,
            DeviceKind::Office,
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline`
Expected: FAIL — не компилируется: ``error[E0425]: cannot find value `MAX_PAGE_BYTES` in module `markiro_host::routes::changes` ``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `super::category_default_id`, `super::ProductStatus`, `super::TemplatePurpose` ``.

- [ ] **Step 3: Записи протокола, сущности ленты и порции по байтам**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub line_id: Option<Option<String>>,
}

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

заменить на

<!-- prettier-ignore -->
```rust
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub line_id: Option<Option<String>>,
}

/// Entities of the change feed (spec §4.4).
pub mod entities {
    pub const ORG_PROFILE: &str = "org_profile";
    pub const SITE: &str = "site";
    pub const LINES: &str = "lines";
    pub const OPERATORS: &str = "operators";
    pub const OPERATOR_BADGES: &str = "operator_badges";
    pub const PRODUCTS: &str = "products";
    pub const LABEL_TEMPLATES: &str = "label_templates";
    pub const CATEGORY_TEMPLATE_DEFAULTS: &str = "category_template_defaults";
}

/// The feed id of a category default: `<code>:<purpose>` (`8:box`), the
/// same text the host's feed query builds in SQL.
pub fn category_default_id(chz_product_group_code: u32, purpose: TemplatePurpose) -> String {
    format!("{chz_product_group_code}:{}", purpose.as_str())
}
```

2. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[serde(rename_all = "camelCase")]
pub struct ChangeItem {
    /// One of [`entities`].
    pub entity: String,
    pub id: String,
    pub rev: i64,
    pub deleted: bool,
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`],
    /// [`OperatorRecord`], [`OperatorBadgeRecord`]); absent when `deleted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[serde(rename_all = "camelCase")]
pub struct ChangeItem {
    /// One of [`entities`].
    pub entity: String,
    pub id: String,
    pub rev: i64,
    pub deleted: bool,
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`],
    /// [`OperatorRecord`], [`OperatorBadgeRecord`], [`ProductRecord`],
    /// [`LabelTemplateRecord`], [`CategoryTemplateDefault`]); absent when
    /// `deleted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgRecord {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgRecord {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
    /// The organization's default template of each purpose (spec §4.3), or
    /// `null`. A record from before plan 1e1 has none of the three and reads
    /// as `null`.
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub default_duplicate_template_id: Option<String>,
}
```

4. Там же фрагмент

<!-- prettier-ignore -->
```rust
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

заменить на

<!-- prettier-ignore -->
```rust
/// operator is there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorBadgeRecord {
    pub operator_id: String,
    /// PBKDF2 PHC string of the badge code, with the site's badge salt.
    pub badge_phc: Secret,
    pub label: Option<String>,
}

/// What a label template prints (spec §4.3). A template's purpose never
/// changes after it is created, and a default slot takes only a template of
/// its own purpose. The order is that of the stored names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplatePurpose {
    Box,
    Pallet,
    ProductDuplicate,
}

impl TemplatePurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplatePurpose::Box => "box",
            TemplatePurpose::Pallet => "pallet",
            TemplatePurpose::ProductDuplicate => "product_duplicate",
        }
    }
}

impl std::str::FromStr for TemplatePurpose {
    type Err = UnknownVariant;

    /// The name [`TemplatePurpose::as_str`] gives, as `label_templates.purpose`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("template purpose", text)
    }
}

/// Whether a product is ready for production (spec §4.3): `active` once it
/// has a product group and both capacities, `draft` before, as the cloud's
/// `computeStatus`. The host computes it; nobody sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductStatus {
    Draft,
    Active,
}

impl ProductStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProductStatus::Draft => "draft",
            ProductStatus::Active => "active",
        }
    }
}

impl std::str::FromStr for ProductStatus {
    type Err = UnknownVariant;

    /// The name [`ProductStatus::as_str`] gives, as `products.status` computes
    /// it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("product status", text)
    }
}

/// `data` of a `products` item. An archived product stays in the feed with
/// `archived: true`: stations keep it for history and leave it out of their
/// pickers. A product is never deleted, so it never leaves as a tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductRecord {
    /// 14 digits, as the office normalized it (`normalizeToGtin14`).
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    /// Preferences: a station uses one only while the template still fits
    /// the product (enabled, of the slot's purpose, covering its group).
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
    pub status: ProductStatus,
}

/// `data` of a `label_templates` item. A disabled template stays in the feed
/// with `enabled: false`; a deleted one leaves as a tombstone. `spec` is the
/// layout as JSON, which a station prints from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTemplateRecord {
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// `null` for every category, otherwise the product-group codes.
    pub chz_product_group_codes: Option<Vec<u32>>,
    /// A stock template: the wizard created it, and it never changes.
    pub stock: bool,
    pub spec: serde_json::Value,
}

/// A category's default template of one purpose: `data` of a
/// `category_template_defaults` item, whose `id` is [`category_default_id`],
/// and an entry of the office's template defaults. A cleared default leaves
/// the feed as a tombstone of that id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTemplateDefault {
    pub chz_product_group_code: u32,
    pub purpose: TemplatePurpose,
    pub template_id: String,
}
```

5. В `apps/standalone/host/src/routes/changes.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! The change feed (spec §4.4) and its live stream (spec §4.5). `GET
//! /v1/changes` returns reference records changed after a device's revision,
//! in pages that never split a revision; `GET /v1/changes/stream` follows up
//! with server-sent events so a device does not have to poll for the next
//! one, until the host stops or the device is revoked. Adding an entity
//! means a branch in `FEED_KEYS` and in `record`, its
//! proto record type, Zod schema and fixture, and a tombstone wherever it is
//! deleted or stops granting access (`feed`).
```

заменить на

<!-- prettier-ignore -->
```rust
//! The change feed (spec §4.4) and its live stream (spec §4.5). `GET
//! /v1/changes` returns reference records changed after a device's revision,
//! in pages that never split a revision and stop at about
//! [`MAX_PAGE_BYTES`]; `GET /v1/changes/stream` follows up
//! with server-sent events so a device does not have to poll for the next
//! one, until the host stops or the device is revoked. Adding an entity
//! means a branch in `FEED_KEYS` and in `record`, its
//! proto record type, Zod schema and fixture, and a tombstone wherever it is
//! deleted or stops granting access (`feed`).
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::stream::unfold;
use markiro_proto::{
    credentials, entities, ChangeItem, ChangesResponse, LineRecord, OperatorBadgeRecord,
    OperatorRecord, OrgRecord, Secret, SiteRecord,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use tokio::sync::watch;
```

заменить на

<!-- prettier-ignore -->
```rust
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::stream::unfold;
use markiro_proto::{
    credentials, entities, CategoryTemplateDefault, ChangeItem, ChangesResponse,
    LabelTemplateRecord, LineRecord, OperatorBadgeRecord, OperatorRecord, OrgRecord, ProductRecord,
    Secret, SiteRecord,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use tokio::sync::watch;
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
pub const DEFAULT_LIMIT: u32 = 500;
pub const MAX_LIMIT: u32 = 1000;

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

заменить на

<!-- prettier-ignore -->
```rust
pub const DEFAULT_LIMIT: u32 = 500;
pub const MAX_LIMIT: u32 = 1000;

/// About how much item JSON one page carries. A template's `spec` may be
/// 256 KB, so a page cut by count alone could reach a hundred megabytes; a
/// page also ends before the revision that would take its items past this.
/// A revision larger than the budget still comes whole when it starts the
/// page, so the feed always moves on.
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;

/// Every feed record changed after `?1`: live rows of each entity, then
/// tombstones. `site` joins only once the wizard has initialized the host;
/// an operator only while active and a badge only while not revoked, since
/// their tombstones say they left. Archived products and disabled templates
/// stay, with their flags. A category default's id is `<code>:<purpose>`,
/// as `markiro_proto::category_default_id` builds it.
const FEED_KEYS: &str = "\
    SELECT 'org_profile' AS entity, '1' AS id, rev, 0 AS deleted FROM org_profile WHERE rev > ?1 \
    UNION ALL SELECT 'site', '1', rev, 0 FROM site WHERE rev > ?1 AND initialized_at IS NOT NULL \
    UNION ALL SELECT 'lines', id, rev, 0 FROM lines WHERE rev > ?1 \
    UNION ALL SELECT 'operators', id, rev, 0 FROM operators WHERE rev > ?1 AND active = 1 \
    UNION ALL SELECT 'operator_badges', id, rev, 0 FROM operator_badges WHERE rev > ?1 AND revoked_at IS NULL \
    UNION ALL SELECT 'products', id, rev, 0 FROM products WHERE rev > ?1 \
    UNION ALL SELECT 'label_templates', id, rev, 0 FROM label_templates WHERE rev > ?1 \
    UNION ALL SELECT 'category_template_defaults', chz_group_code || ':' || purpose, rev, 0 \
        FROM category_template_defaults WHERE rev > ?1 \
    UNION ALL SELECT entity, id, rev, 1 FROM tombstones WHERE rev > ?1";
```

8. Там же фрагмент

<!-- prettier-ignore -->
```rust
struct Page {
    keys: Vec<Key>,
    /// The last revision the page holds completely; `None` when nothing
    /// more follows, so the answer carries the host's current revision.
    more_after: Option<i64>,
}
```

заменить на

<!-- prettier-ignore -->
```rust
struct Page {
    keys: Vec<Key>,
    /// The last revision the page holds completely; `None` when nothing
    /// more follows, so the answer carries the host's current revision.
    more_after: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct OrgFeedRow {
    name: String,
    inn: Option<String>,
    gln: String,
    gs1_prefixes: String,
    time_zone: String,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    default_duplicate_template_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ProductFeedRow {
    gtin14: String,
    name: String,
    print_name: Option<String>,
    chz_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    archived: bool,
    status: String,
}

#[derive(sqlx::FromRow)]
struct TemplateFeedRow {
    name: String,
    purpose: String,
    enabled: bool,
    category_codes: Option<String>,
    stock: bool,
    spec: String,
}
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
    }
    // One read transaction: the records and the current revision come from
    // one WAL snapshot, so a concurrent write cannot slip between them.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let current = db::current_revision(&mut tx)
        .await
        .map_err(ApiError::internal)?;
    let page = page(&mut tx, since, limit).await?;
    let mut items = Vec::with_capacity(page.keys.len());
    for key in &page.keys {
        items.push(item(&mut tx, key).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(ChangesResponse {
        host_id: state.host_id.clone(),
        rev: page.more_after.unwrap_or(current),
        // `more_after` can equal `current` when the last page happens to end
        // exactly on the host's newest revision: that is not "more to fetch".
        has_more: page.more_after.is_some_and(|rev| rev < current),
        items,
    }))
}
```

заменить на

<!-- prettier-ignore -->
```rust
    }
    // One read transaction: the records and the current revision come from
    // one WAL snapshot, so a concurrent write cannot slip between them.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let current = db::current_revision(&mut tx)
        .await
        .map_err(ApiError::internal)?;
    let page = page(&mut tx, since, limit).await?;
    let (items, more_after) = within_budget(&mut tx, page).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(ChangesResponse {
        host_id: state.host_id.clone(),
        rev: more_after.unwrap_or(current),
        // `more_after` can equal `current` when the last page happens to end
        // exactly on the host's newest revision: that is not "more to fetch".
        has_more: more_after.is_some_and(|rev| rev < current),
        items,
    }))
}

/// The page's records, ending before the first revision that would take
/// them past [`MAX_PAGE_BYTES`] of JSON; the first revision comes whole,
/// however large. Returns them with the last revision they hold completely
/// when more follow, or `None` when nothing does.
async fn within_budget(
    conn: &mut SqliteConnection,
    page: Page,
) -> Result<(Vec<ChangeItem>, Option<i64>), ApiError> {
    let mut items: Vec<ChangeItem> = Vec::with_capacity(page.keys.len());
    let mut bytes = 0;
    let mut keys = page.keys.iter().peekable();
    while let Some(rev) = keys.peek().map(|key| key.rev) {
        let mut revision = Vec::new();
        let mut revision_bytes = 0;
        while let Some(key) = keys.next_if(|key| key.rev == rev) {
            let item = item(conn, key).await?;
            revision_bytes += serde_json::to_vec(&item).map_err(ApiError::internal)?.len();
            revision.push(item);
        }
        if !items.is_empty() && bytes + revision_bytes > MAX_PAGE_BYTES {
            let last = items.last().map(|item| item.rev);
            return Ok((items, last));
        }
        bytes += revision_bytes;
        items.append(&mut revision);
    }
    Ok((items, page.more_after))
}
```

10. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// The live record behind a feed key, as its proto record type.
async fn record(conn: &mut SqliteConnection, key: &Key) -> Result<serde_json::Value, ApiError> {
    let value = match key.entity.as_str() {
        entities::ORG_PROFILE => {
            let (name, inn, gln, gs1_prefixes, time_zone): (
                String,
                Option<String>,
                String,
                String,
                String,
            ) = sqlx::query_as(
                "SELECT name, inn, gln, gs1_prefixes, time_zone FROM org_profile WHERE id = 1",
            )
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(OrgRecord {
                name,
                inn,
                gln,
                gs1_prefixes: serde_json::from_str(&gs1_prefixes).map_err(ApiError::internal)?,
                time_zone,
            })
        }
        entities::SITE => {
            let (badge_salt, box_block_size, pallet_block_size): (Vec<u8>, i64, i64) =
                sqlx::query_as(
                    "SELECT badge_salt, box_block_size, pallet_block_size FROM site WHERE id = 1",
                )
                .fetch_one(&mut *conn)
```

заменить на

<!-- prettier-ignore -->
```rust
/// The live record behind a feed key, as its proto record type.
async fn record(conn: &mut SqliteConnection, key: &Key) -> Result<serde_json::Value, ApiError> {
    let value = match key.entity.as_str() {
        entities::ORG_PROFILE => {
            let row: OrgFeedRow = sqlx::query_as(
                "SELECT name, inn, gln, gs1_prefixes, time_zone, default_box_template_id, \
                 default_pallet_template_id, default_duplicate_template_id \
                 FROM org_profile WHERE id = 1",
            )
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(OrgRecord {
                name: row.name,
                inn: row.inn,
                gln: row.gln,
                gs1_prefixes: serde_json::from_str(&row.gs1_prefixes)
                    .map_err(ApiError::internal)?,
                time_zone: row.time_zone,
                default_box_template_id: row.default_box_template_id,
                default_pallet_template_id: row.default_pallet_template_id,
                default_duplicate_template_id: row.default_duplicate_template_id,
            })
        }
        entities::SITE => {
            let (badge_salt, box_block_size, pallet_block_size): (Vec<u8>, i64, i64) =
                sqlx::query_as(
                    "SELECT badge_salt, box_block_size, pallet_block_size FROM site WHERE id = 1",
                )
                .fetch_one(&mut *conn)
```

11. Там же фрагмент

<!-- prettier-ignore -->
```rust
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
        other => {
            return Err(ApiError::internal(format!(
                "no feed record type for {other}"
            )))
        }
    };
```

заменить на

<!-- prettier-ignore -->
```rust
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
        entities::PRODUCTS => {
            let row: ProductFeedRow = sqlx::query_as(
                "SELECT gtin14, name, print_name, chz_group_code, box_capacity, \
                 pallet_box_capacity, shelf_life_days, default_box_template_id, \
                 default_pallet_template_id, archived, status FROM products WHERE id = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(ProductRecord {
                gtin14: row.gtin14,
                name: row.name,
                print_name: row.print_name,
                chz_product_group_code: row.chz_group_code,
                box_capacity: row.box_capacity,
                pallet_box_capacity: row.pallet_box_capacity,
                shelf_life_days: row.shelf_life_days,
                default_box_template_id: row.default_box_template_id,
                default_pallet_template_id: row.default_pallet_template_id,
                archived: row.archived,
                status: row.status.parse().map_err(ApiError::internal)?,
            })
        }
        entities::LABEL_TEMPLATES => {
            let row: TemplateFeedRow = sqlx::query_as(
                "SELECT name, purpose, enabled, category_codes, stock, spec \
                 FROM label_templates WHERE id = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(LabelTemplateRecord {
                name: row.name,
                purpose: row.purpose.parse().map_err(ApiError::internal)?,
                enabled: row.enabled,
                chz_product_group_codes: row
                    .category_codes
                    .map(|codes| serde_json::from_str(&codes))
                    .transpose()
                    .map_err(ApiError::internal)?,
                stock: row.stock,
                spec: serde_json::from_str(&row.spec).map_err(ApiError::internal)?,
            })
        }
        entities::CATEGORY_TEMPLATE_DEFAULTS => {
            let (code, purpose, template_id): (u32, String, String) = sqlx::query_as(
                "SELECT chz_group_code, purpose, template_id FROM category_template_defaults \
                 WHERE chz_group_code || ':' || purpose = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(CategoryTemplateDefault {
                chz_product_group_code: code,
                purpose: purpose.parse().map_err(ApiError::internal)?,
                template_id,
            })
        }
        other => {
            return Err(ApiError::internal(format!(
                "no feed record type for {other}"
            )))
        }
    };
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline`
Expected: PASS — 18 тестов (15 прежних и 3 новых).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 5 модульных тестов и 30 тестов фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`GET /v1/changes?since=<rev>&limit=<n>` (`routes/changes.rs`) returns the
station-visible reference records changed after a device's revision:
`org_profile`, `site` (badge salt and block sizes), `lines`, `operators`,
`operator_badges`, plus deletions from `tombstones`. Pages are ordered by
`(rev, entity, id)` and never split a revision; with `hasMore = false`,
`rev` is the host's current revision, so revisions that changed only office
data still move a device forward; an office line assignment for a device is
one of those (see «Device key and office session»).
`GET /v1/changes/stream` sends the current revision as its first event, then
an event whenever the revision grew: events are strictly increasing, so a
burst of commits collapses into one, and an event means "fetch since your
revision", not "a commit happened"; a comment heartbeat keeps the connection
alive every 15 s, and streams end when the host stops or when their device
is revoked: a revocation raises `AppState::revocations` after its commit,
and every open stream re-reads its own device then. A new feed entity
needs a branch in `FEED_KEYS` and in `record`, its proto record type, Zod
```

заменить на

<!-- prettier-ignore -->
```text
`GET /v1/changes?since=<rev>&limit=<n>` (`routes/changes.rs`) returns the
station-visible reference records changed after a device's revision:
`org_profile`, `site` (badge salt and block sizes), `lines`, `operators`,
`operator_badges`, `products`, `label_templates`,
`category_template_defaults`, plus deletions from `tombstones`. Pages are
ordered by `(rev, entity, id)` and never split a revision; with
`hasMore = false`, `rev` is the host's current revision, so revisions that
changed only office data still move a device forward; an office line
assignment for a device is one of those (see «Device key and office
session»). A page holds at most `limit` records and ends before the
revision that would take its items past `MAX_PAGE_BYTES` (1 MiB) of JSON,
since a template's `spec` may be 256 KB; a revision larger than either
bound still comes whole when it starts the page, so the feed always moves
on.
`GET /v1/changes/stream` sends the current revision as its first event, then
an event whenever the revision grew: events are strictly increasing, so a
burst of commits collapses into one, and an event means "fetch since your
revision", not "a commit happened"; a comment heartbeat keeps the connection
alive every 15 s, and streams end when the host stops or when their device
is revoked: a revocation raises `AppState::revocations` after its commit,
and every open stream re-reads its own device then. A new feed entity
needs a branch in `FEED_KEYS` and in `record`, its proto record type, Zod
```

2. Там же фрагмент

<!-- prettier-ignore -->
```text
the feed only while active: a deactivation writes a tombstone for its id, and
a reactivation drops the tombstone and sends the record again with a new
`rev`. A badge is in the feed only while not revoked: a revocation writes a
tombstone, and a revoked badge never comes back — a new badge gets a new id.
A PIN change is a record update carrying the new `pinPhc`, so the station
replaces the hash and the old PIN stops working. A badge record never grants
access on its own: the station's operator login (plan 1f) requires the record
of its `operatorId`.

On the device side a new entity also needs its entry in `ENTITIES`
(`src/local/reference-sync.ts`), which derives `ENTITY_SET`; a new entity
there changes `ENTITY_SET` and makes every device sync from zero once. It
also adds three statements to the worst-case page batch (see "Reference
sync"), which must stay within the shell's 32.
```

заменить на

<!-- prettier-ignore -->
```text
the feed only while active: a deactivation writes a tombstone for its id, and
a reactivation drops the tombstone and sends the record again with a new
`rev`. A badge is in the feed only while not revoked: a revocation writes a
tombstone, and a revoked badge never comes back — a new badge gets a new id.
A PIN change is a record update carrying the new `pinPhc`, so the station
replaces the hash and the old PIN stops working. A badge record never grants
access on its own: the station's operator login (plan 1f) requires the record
of its `operatorId`.

The catalog grants no access, so its flags stay flags: an archived product
and a disabled template ride the feed with `archived` and `enabled`, since a
station keeps them for history and leaves them out of its pickers. A
product is never deleted and never has a tombstone; a deleted template
leaves as one. A category default is keyed `<code>:<purpose>` (`8:box`,
`markiro_proto::category_default_id`, the same text `FEED_KEYS` builds in
SQL), and clearing it writes a tombstone of that key. The organization's
three defaults ride its record (`defaultBoxTemplateId`,
`defaultPalletTemplateId`, `defaultDuplicateTemplateId`, `null` when unset).
A template's `spec` travels as JSON, not as text. Within one revision a
deleted template's tombstone comes before the products whose defaults the
delete cleared (entities sort by name), and a template a copy refers to may
sit in the quarantine, so the station's copies take no foreign key from a
product or a default to a template.

On the device side a new entity also needs its entry in `ENTITIES`
(`src/local/reference-sync.ts`), which derives `ENTITY_SET`; a new entity
there changes `ENTITY_SET` and makes every device sync from zero once. It
also adds three statements to the worst-case page batch (see "Reference
sync"), which must stay within the shell's 32.
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
  запись с новой ревизией. Бейдж в ленте, только пока не отозван: отзыв пишет
  надгробие, отозванный бейдж не возвращается, новый бейдж получает новый
  идентификатор. Смена PIN — обновление записи с новым `pinPhc`. Запись бейджа
  сама доступа не даёт: вход оператора на станции (план 1f) требует запись
  оператора с этим `operatorId`.
- Ключ, который вернулся в ленту после надгробия (оператор включён снова),
  удаляет своё надгробие: лента никогда не несёт и надгробие, и запись одного
  ключа (`feed::restore`).
- Смена линии устройства в офисе (`PUT /v1/office/devices/{id}`) берёт одну ревизию
  хоста, но записи ленты не порождает (устройства в ленту не входят): потоки
  просыпаются, и станция заново читает `GET /v1/device` (§5.1). Переименование
  устройства и повтор той же линии ревизию не берут. Как это сочетается с идущей
  сменой — решение плана 2a.
- После коммита хост оповещает подписчиков потока о новой ревизии (канал
  `tokio::sync::watch`).
```

заменить на

<!-- prettier-ignore -->
```text
  запись с новой ревизией. Бейдж в ленте, только пока не отозван: отзыв пишет
  надгробие, отозванный бейдж не возвращается, новый бейдж получает новый
  идентификатор. Смена PIN — обновление записи с новым `pinPhc`. Запись бейджа
  сама доступа не даёт: вход оператора на станции (план 1f) требует запись
  оператора с этим `operatorId`.
- Ключ, который вернулся в ленту после надгробия (оператор включён снова),
  удаляет своё надгробие: лента никогда не несёт и надгробие, и запись одного
  ключа (`feed::restore`).
- Каталог доступа не даёт, поэтому его признаки остаются признаками (план 1e1):
  архивный товар и выключенный шаблон идут по ленте с `archived` и `enabled` —
  станция хранит их для истории и не предлагает в выборе. Товар не удаляется и
  надгробия не получает; удалённый шаблон уходит надгробием. Ключ умолчания
  категории — `<код>:<назначение>` (`8:box`), снятое умолчание уходит надгробием
  этого ключа. Три шаблона по умолчанию организации едут в её записи
  (`defaultBoxTemplateId`, `defaultPalletTemplateId`,
  `defaultDuplicateTemplateId`, `null`, если не заданы). `spec` шаблона едет как
  JSON, а не как текст. Внутри одной ревизии надгробие удалённого шаблона идёт
  раньше товаров, у которых удаление сняло ссылку (сущности упорядочены по
  имени), поэтому копии станции не держат внешних ключей на шаблоны.
- Порция ленты не больше `limit` записей и заканчивается перед ревизией, с
  которой JSON её записей перевалил бы за `MAX_PAGE_BYTES` (1 МиБ): `spec`
  шаблона бывает до 256 КБ. Ревизия больше любой из границ приходит целиком,
  если она в порции первая, — лента всегда продвигается.
- Смена линии устройства в офисе (`PUT /v1/office/devices/{id}`) берёт одну ревизию
  хоста, но записи ленты не порождает (устройства в ленту не входят): потоки
  просыпаются, и станция заново читает `GET /v1/device` (§5.1). Переименование
  устройства и повтор той же линии ревизию не берут. Как это сочетается с идущей
  сменой — решение плана 2a.
- После коммита хост оповещает подписчиков потока о новой ревизии (канал
  `tokio::sync::watch`).
```

4. Там же фрагмент

<!-- prettier-ignore -->
```text
| Метод и путь                                                                                                  | Доступ                                          | Назначение                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/hello`                                                                                               | любой                                           | `{ product: "markiro-host", protocol, minProtocol, hostId, version, time, initialized }`                                                                                                                                                                                                                                                                                                 |
| `POST /v1/local-pair`                                                                                         | только loopback                                 | Подключение устройства на том же ПК: `{ kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                      |
| `POST /v1/bootstrap`                                                                                          | устройство, loopback, хост не инициализирован   | Мастер первого запуска: администратор, организация, счётчики SSCC, линии, типовые шаблоны → `{ session }`                                                                                                                                                                                                                                                                                |
| `POST /v1/pairing/claim`                                                                                      | любой, ограничение частоты                      | `{ code, kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                                                     |
| `GET /v1/device`                                                                                              | устройство                                      | Сведения об устройстве и его линии                                                                                                                                                                                                                                                                                                                                                       |
| `PUT /v1/device/line`                                                                                         | устройство (станция)                            | Выбор линии после подключения                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/changes?since=<rev>&limit=<n>`                                                                       | устройство                                      | `{ hostId, rev, hasMore, items: [{ entity, id, rev, deleted, data }] }`, по умолчанию 500 записей (не больше 1000); порция не разрывает ревизию; без новых записей `rev` — текущая ревизия хоста                                                                                                                                                                                         |
| `GET /v1/changes/stream`                                                                                      | устройство                                      | SSE: первым событием — текущая ревизия хоста; затем событие `rev` с `{ rev }` после каждого коммита, поднявшего ревизию (события строго возрастают, всплеск коммитов схлопывается в одно; событие значит «запросите ленту начиная со своей последней ревизии», а не «случился коммит»); комментарий-пульс каждые 15 с; поток заканчивается при остановке хоста или при отзыве устройства |
| `POST /v1/office/login`                                                                                       | устройство                                      | `{ login, password }` → `{ token, user, expiresAt }`                                                                                                                                                                                                                                                                                                                                     |
| `POST /v1/office/logout`, `GET /v1/office/me`                                                                 | офисная сессия                                  | Выход, текущий пользователь                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /v1/office/me/password`                                                                                  | офисная сессия, ограничение частоты             | Смена своего пароля: `{ currentPassword, newPassword }`; остальные сессии пользователя закрываются, текущая остаётся                                                                                                                                                                                                                                                                     |
| `GET/PUT /v1/office/org`                                                                                      | чтение — все роли, запись — администратор       | Профиль организации                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v1/office/sscc`, `PUT /v1/office/sscc/counters/{prefix}/{extension}`, `PUT /v1/office/sscc/block-sizes` | чтение — все, запись — администратор            | Счётчики и размеры блоков                                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/PUT /v1/office/counterparties…`                                                                     | чтение — все, запись — администратор            | Контрагенты (архивирование вместо удаления)                                                                                                                                                                                                                                                                                                                                              |
| `GET/POST/PUT /v1/office/operators…`, `POST/DELETE /v1/office/operators/{id}/badges…`                         | администратор                                   | Операторы, PIN, бейджи; `GET /v1/office/badge-salt` — соль для расчёта хеша                                                                                                                                                                                                                                                                                                              |
```

заменить на

<!-- prettier-ignore -->
```text
| Метод и путь                                                                                                  | Доступ                                          | Назначение                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/hello`                                                                                               | любой                                           | `{ product: "markiro-host", protocol, minProtocol, hostId, version, time, initialized }`                                                                                                                                                                                                                                                                                                 |
| `POST /v1/local-pair`                                                                                         | только loopback                                 | Подключение устройства на том же ПК: `{ kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                      |
| `POST /v1/bootstrap`                                                                                          | устройство, loopback, хост не инициализирован   | Мастер первого запуска: администратор, организация, счётчики SSCC, линии, типовые шаблоны → `{ session }`                                                                                                                                                                                                                                                                                |
| `POST /v1/pairing/claim`                                                                                      | любой, ограничение частоты                      | `{ code, kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                                                     |
| `GET /v1/device`                                                                                              | устройство                                      | Сведения об устройстве и его линии                                                                                                                                                                                                                                                                                                                                                       |
| `PUT /v1/device/line`                                                                                         | устройство (станция)                            | Выбор линии после подключения                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/changes?since=<rev>&limit=<n>`                                                                       | устройство                                      | `{ hostId, rev, hasMore, items: [{ entity, id, rev, deleted, data }] }`, по умолчанию 500 записей (не больше 1000) и не больше 1 МиБ JSON записей; порция не разрывает ревизию; без новых записей `rev` — текущая ревизия хоста                                                                                                                                                          |
| `GET /v1/changes/stream`                                                                                      | устройство                                      | SSE: первым событием — текущая ревизия хоста; затем событие `rev` с `{ rev }` после каждого коммита, поднявшего ревизию (события строго возрастают, всплеск коммитов схлопывается в одно; событие значит «запросите ленту начиная со своей последней ревизии», а не «случился коммит»); комментарий-пульс каждые 15 с; поток заканчивается при остановке хоста или при отзыве устройства |
| `POST /v1/office/login`                                                                                       | устройство                                      | `{ login, password }` → `{ token, user, expiresAt }`                                                                                                                                                                                                                                                                                                                                     |
| `POST /v1/office/logout`, `GET /v1/office/me`                                                                 | офисная сессия                                  | Выход, текущий пользователь                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /v1/office/me/password`                                                                                  | офисная сессия, ограничение частоты             | Смена своего пароля: `{ currentPassword, newPassword }`; остальные сессии пользователя закрываются, текущая остаётся                                                                                                                                                                                                                                                                     |
| `GET/PUT /v1/office/org`                                                                                      | чтение — все роли, запись — администратор       | Профиль организации                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v1/office/sscc`, `PUT /v1/office/sscc/counters/{prefix}/{extension}`, `PUT /v1/office/sscc/block-sizes` | чтение — все, запись — администратор            | Счётчики и размеры блоков                                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/PUT /v1/office/counterparties…`                                                                     | чтение — все, запись — администратор            | Контрагенты (архивирование вместо удаления)                                                                                                                                                                                                                                                                                                                                              |
| `GET/POST/PUT /v1/office/operators…`, `POST/DELETE /v1/office/operators/{id}/badges…`                         | администратор                                   | Операторы, PIN, бейджи; `GET /v1/office/badge-salt` — соль для расчёта хеша                                                                                                                                                                                                                                                                                                              |
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/changes-catalog.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline`
Expected: PASS — 251 тест.

```bash
git add apps/standalone/host/src/routes/changes.rs apps/standalone/host/tests/changes.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/changes-catalog.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): каталог в ленте — товары, шаблоны, умолчания категорий и порции по байтам" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Права каталога и товары — `require_catalog_in`, `GET/POST/PUT /v1/office/products`

Каталог пишут администратор и технолог (спецификация §4.8, `editCatalog`). `OfficeContext` получает пару, как у записей администратора: `require_catalog` — ранний отказ, `require_catalog_in` — проверка внутри транзакции записи (сессия жива, пользователь активен, роль подходит). Список ролей — `auth::edits_catalog` с `match` без ветки по умолчанию: новая роль не скомпилируется, пока её не разместят. Отказ `forbidden` сейчас недостижим; что проверка внутри транзакции действует, тест показывает прямо — выключенный после экстрактора технолог получает `unauthorized`.

Товары: список — все роли, архивные тоже (по `archived, name, id`, побайтно, как линии); создание и правка — администратор и технолог. `PUT` несёт запись целиком с `expectedRev`, как у контрагента: форма правит все поля сразу, а частичное обновление различало бы «поле не прислано» и `null`. У `gtin14` хост проверяет только вид, уникальность — среди товаров в работе (`conflict` на `gtin14` при создании, смене GTIN и возврате из архива). `status` вычисляет столбец. Шаблоны товара по умолчанию — пожелания: хост проверяет, что шаблон есть и его назначение совпадает со слотом; включённость и покрытие группы проверяют интерфейс и станция (решение 9 в Global Constraints). Шаблоны в тестах этой задачи пишутся прямо в таблицу: маршруты шаблонов — задача 4.

Общая поддержка тестов получает `Admin::feed` (лента станции администратора), `Admin::technologist_session` (токен и id технолога) и `audit_row` (строка журнала любого пользователя): ими пользуются тесты задач 3–5.

**Files:**

- Create: `apps/standalone/host/tests/products.rs`, `apps/standalone/proto/fixtures/office-product.json`, `product-create.json`, `product-update.json`
- Modify: `apps/standalone/host/src/{auth,validate,audit,server}.rs`, `apps/standalone/proto/src/lib.rs`; `apps/standalone/host/src/routes/products.rs` — целиком
- Test: `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/validate.rs` (модуль `tests`)
- Modify: `apps/standalone/AGENTS.md` («Writes», «Catalog and label templates»), спецификация §4.3, §4.6

**Interfaces:**

- Consumes:
  - `OfficeContext::live_role_in`, `OfficeRole` — `host/src/auth.rs`, `proto/src/lib.rs`;
  - `clean_text`, `optional_text`, `digits` — `host/src/validate.rs`;
  - `audit::{record, update_details, Entry, Outcome}`, `ApiError::conflict_on_unique_violation`;
  - таблицы `products`, `chz_product_groups`, `label_templates` (задача 1), `ProductStatus` (задача 2);
  - `admin`, `Admin::{call, call_as, row}`, `seed_office_user`, `login`, `audit_trail`, `audit_rows`, `host_revision` — `host/tests/support/app.rs`.
- Produces:
  - `pub fn OfficeContext::require_catalog(&self) -> Result<(), ApiError>`, `pub async fn OfficeContext::require_catalog_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError>`, `pub fn auth::edits_catalog(role: OfficeRole) -> bool`;
  - `validate::{gtin14, product_name, print_name, count}`, `MAX_BOX_CAPACITY = 100_000`, `MAX_PALLET_BOX_CAPACITY = 10_000`, `MAX_SHELF_LIFE_DAYS = 3_650`;
  - `actions::{PRODUCT_CREATE, PRODUCT_UPDATE}`;
  - `OfficeProduct`, `ProductCreate`, `ProductUpdate` — `proto/src/lib.rs`;
  - `routes::products::{list_products, create_product, update_product}`;
  - тестовая поддержка: `Admin::feed(&self, since: i64) -> Value`, `Admin::technologist_session(&self) -> (String, String)`, `pub fn audit_row(actor_id: &str, action: &str, target_type: &str, target_id: &str, details: Value) -> AuditRow`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/office-product.json`:

<!-- prettier-ignore -->
```json
{
  "id": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "gtin14": "04600682000013",
  "name": "Молоко 3,2% 0,9 л",
  "printName": "Молоко 3,2%",
  "chzProductGroupCode": 8,
  "boxCapacity": 12,
  "palletBoxCapacity": 40,
  "shelfLifeDays": 10,
  "defaultBoxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "defaultPalletTemplateId": null,
  "archived": false,
  "status": "active",
  "rev": 65
}
```

2. Create `apps/standalone/proto/fixtures/product-create.json`:

<!-- prettier-ignore -->
```json
{
  "gtin14": "04600682000013",
  "name": "Молоко 3,2% 0,9 л",
  "printName": "Молоко 3,2%",
  "chzProductGroupCode": 8,
  "boxCapacity": 12,
  "palletBoxCapacity": 40,
  "shelfLifeDays": 10,
  "defaultBoxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "defaultPalletTemplateId": null
}
```

3. Create `apps/standalone/proto/fixtures/product-update.json`:

<!-- prettier-ignore -->
```json
{
  "gtin14": "04600682000013",
  "name": "Молоко 3,2% 0,9 л",
  "printName": null,
  "chzProductGroupCode": 8,
  "boxCapacity": 12,
  "palletBoxCapacity": 48,
  "shelfLifeDays": 10,
  "defaultBoxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "defaultPalletTemplateId": null,
  "archived": true,
  "expectedRev": 65
}
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope,
    LabelTemplateRecord, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate,
    OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord,
    OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode,
    PairingCodeRequest, PasswordChange, PasswordSet, ProductGroup, ProductRecord, ProductStatus,
    SiteRecord, SsccCounterUpdate, SsccState, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope,
    LabelTemplateRecord, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeUser,
    OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate,
    OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, SiteRecord, SsccCounterUpdate, SsccState,
    TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn product_fixtures_round_trip_and_requests_reject_unknown_fields() {
    let product: OfficeProduct = round_trip("office-product.json");
    assert_eq!(product.status, ProductStatus::Active);
    let create: ProductCreate = round_trip("product-create.json");
    assert_eq!(create.gtin14, product.gtin14);
    let update: ProductUpdate = round_trip("product-update.json");
    assert_eq!((update.archived, update.print_name), (true, None));
    // Left out, an optional field reads as none.
    let bare: ProductCreate =
        serde_json::from_value(serde_json::json!({ "gtin14": "04600682000013", "name": "Молоко" }))
            .unwrap();
    assert_eq!(
        (
            bare.print_name,
            bare.chz_product_group_code,
            bare.box_capacity
        ),
        (None, None, None)
    );
    // A product is created in use, and nobody sends its status.
    let mut value = fixture("product-create.json");
    value["archived"] = Value::Bool(false);
    assert!(serde_json::from_value::<ProductCreate>(value).is_err());
    let mut value = fixture("product-update.json");
    value["status"] = Value::String("active".into());
    assert!(serde_json::from_value::<ProductUpdate>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

6. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
    ) -> (StatusCode, Value) {
        let builder = with_session(request(method, path), &self.key, token);
        match body {
            Some(body) => self.app.send(json(builder, body)).await,
            None => self.app.send(empty(builder)).await,
        }
    }

    /// The feed items a station gets after `since`, with this station's key.
    pub async fn feed(&self, since: i64) -> Value {
        let (status, body) = self
            .app
            .send(empty(with_device(
                request("GET", &format!("/v1/changes?since={since}")),
                &self.key,
            )))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["items"].clone()
    }

    /// A technologist signed in on the same station; returns the token.
    pub async fn technologist(&self) -> String {
        self.technologist_session().await.0
    }

    /// A technologist signed in on the same station; returns the token and
    /// the technologist's id.
    pub async fn technologist_session(&self) -> (String, String) {
        let id = seed_office_user(&self.app, "tech", "technologist", "technologist password").await;
        let token = login(&self.app, &self.key, "tech", "technologist password").await;
        (token, id)
    }
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
    /// The `ok` audit row a change by this administrator writes.
    pub fn row(
        &self,
        action: &str,
        target_type: &str,
        target_id: &str,
        details: Value,
    ) -> AuditRow {
        audit_row(&self.id, action, target_type, target_id, details)
    }
}

/// The `ok` audit row a change by the office user `actor_id` writes.
pub fn audit_row(
    actor_id: &str,
    action: &str,
    target_type: &str,
    target_id: &str,
    details: Value,
) -> AuditRow {
    (
        "office_user".to_owned(),
        Some(actor_id.to_owned()),
        action.to_owned(),
        Some(target_type.to_owned()),
        Some(target_id.to_owned()),
        "ok".to_owned(),
        details,
    )
}
```

8. Create `apps/standalone/host/tests/products.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use markiro_host::auth::OfficeContext;
use serde_json::{json, Value};
use support::app::{admin, audit_row, audit_rows, audit_trail, host_revision, Admin, TestApp};

/// A new product as the office's form sends it, with blanks to trim.
fn milk() -> Value {
    json!({
        "gtin14": " 04600682000013 ",
        "name": " Молоко 3,2% 0,9 л ",
        "printName": " Молоко 3,2% ",
        "chzProductGroupCode": 8,
        "boxCapacity": 12,
        "palletBoxCapacity": 40,
        "shelfLifeDays": 10
    })
}

/// The record `milk()` creates.
fn milk_record(id: &str, rev: i64) -> Value {
    json!({
        "id": id, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л", "printName": "Молоко 3,2%",
        "chzProductGroupCode": 8, "boxCapacity": 12, "palletBoxCapacity": 40, "shelfLifeDays": 10,
        "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
        "archived": false, "status": "active", "rev": rev
    })
}

/// A `PUT` body: every field of `record`, over `expected_rev`.
fn full(record: &Value, expected_rev: i64) -> Value {
    let mut body = record.clone();
    let fields = body.as_object_mut().unwrap();
    for computed in ["id", "status", "rev"] {
        fields.remove(computed);
    }
    fields.insert("expectedRev".to_owned(), json!(expected_rev));
    body
}

async fn create(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", "/v1/office/products", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

fn path(product: &Value) -> String {
    format!("/v1/office/products/{}", product["id"].as_str().unwrap())
}

fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

/// A template written straight into its table (the template routes come
/// with rules of their own); returns its id.
async fn insert_template(
    app: &TestApp,
    purpose: &str,
    enabled: bool,
    codes: Option<&str>,
) -> String {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, rev) \
         VALUES (?, 'Шаблон', ?, ?, ?, '{}', ?)",
    )
    .bind(&id)
    .bind(purpose)
    .bind(enabled)
    .bind(codes)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

#[tokio::test]
async fn an_administrator_creates_lists_and_updates_products() {
    let admin = admin().await;
    let created = create(&admin, milk()).await;
    let id = created["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1.
    assert_eq!(created, milk_record(&id, 2));
    assert_eq!(
        audit_trail(&admin.app, "product.create").await,
        vec![admin.row(
            "product.create",
            "product",
            &id,
            json!({ "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л" })
        )]
    );
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([created.clone()])));
    // Stations get the product without the office's id and revision fields.
    let mut data = full(&created, 0);
    data.as_object_mut().unwrap().remove("expectedRev");
    data["status"] = json!("active");
    assert_eq!(
        admin.feed(1).await,
        json!([{ "entity": "products", "id": id, "rev": 2, "deleted": false, "data": data }])
    );

    let mut change = full(&created, 2);
    change["printName"] = Value::Null;
    change["palletBoxCapacity"] = json!(48);
    change["archived"] = json!(true);
    let (status, updated) = admin
        .call("PUT", &path(&created), Some(change.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["printName"].clone(),
            updated["palletBoxCapacity"].clone(),
            updated["archived"].clone(),
            updated["rev"].clone()
        ),
        (Value::Null, json!(48), json!(true), json!(3))
    );
    assert_eq!(
        audit_trail(&admin.app, "product.update").await,
        vec![admin.row(
            "product.update",
            "product",
            &id,
            json!({
                "changed": ["printName", "palletBoxCapacity", "archived"],
                "printName": { "from": "Молоко 3,2%", "to": null },
                "palletBoxCapacity": { "from": 40, "to": 48 },
                "archived": { "from": false, "to": true }
            })
        )]
    );

    // The same values again change nothing.
    change["expectedRev"] = json!(3);
    let (status, same) = admin.call("PUT", &path(&created), Some(change)).await;
    assert_eq!((status, same), (StatusCode::OK, updated));
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_trail(&admin.app, "product.update").await.len(), 1);
    // An update over an old revision is refused and writes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("PUT", &path(&created), Some(full(&created, 2)))
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(3))
    );
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_product_is_active_once_it_has_a_group_and_both_capacities() {
    let admin = admin().await;
    let draft = create(
        &admin,
        json!({ "gtin14": "04600682000020", "name": "Кефир 1% 0,9 л" }),
    )
    .await;
    assert_eq!(
        (draft["status"].clone(), draft["printName"].clone()),
        (json!("draft"), Value::Null)
    );
    let mut body = full(&draft, 2);
    body["chzProductGroupCode"] = json!(8);
    body["boxCapacity"] = json!(12);
    let (status, still) = admin.call("PUT", &path(&draft), Some(body)).await;
    assert_eq!(
        (status, still["status"].clone()),
        (StatusCode::OK, json!("draft"))
    );
    let mut body = full(&still, 3);
    body["palletBoxCapacity"] = json!(40);
    let (status, active) = admin.call("PUT", &path(&draft), Some(body)).await;
    assert_eq!(
        (status, active["status"].clone()),
        (StatusCode::OK, json!("active"))
    );
    assert_eq!(admin.feed(3).await[0]["data"]["status"], json!("active"));
}

#[tokio::test]
async fn a_gtin_is_unique_among_products_in_use() {
    let admin = admin().await;
    let first = create(&admin, milk()).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/products", Some(milk()))
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("gtin14"))
    );
    assert_eq!(
        host_revision(&admin.app).await,
        2,
        "a refused write takes no revision"
    );
    assert_eq!(audit_rows(&admin.app).await, rows);

    // Once the first is archived, its GTIN is free...
    let mut archive = full(&first, 2);
    archive["archived"] = json!(true);
    let (status, archived) = admin.call("PUT", &path(&first), Some(archive)).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    create(&admin, milk()).await;
    // ...and the archived one cannot come back while another product in use
    // holds it.
    let mut restore = full(&archived, 3);
    restore["archived"] = json!(false);
    let (status, body) = admin.call("PUT", &path(&first), Some(restore)).await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("gtin14"))
    );
    let sharing: Vec<bool> = sqlx::query_scalar(
        "SELECT archived FROM products WHERE gtin14 = '04600682000013' ORDER BY archived",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(sharing, vec![false, true]);
}

#[tokio::test]
async fn product_fields_are_checked() {
    let admin = admin().await;
    let unknown = "9b2e4a6c-0000-4000-8000-000000000000";
    for (field, value) in [
        ("gtin14", json!("4600682000013")),
        ("gtin14", json!("0460068200001X")),
        ("name", json!(" ")),
        ("name", json!("м".repeat(201))),
        ("name", json!("Молоко\u{0}")),
        ("printName", json!("м".repeat(201))),
        // 18 is not a ЧЗ product group.
        ("chzProductGroupCode", json!(18)),
        ("boxCapacity", json!(0)),
        ("boxCapacity", json!(100_001)),
        ("palletBoxCapacity", json!(10_001)),
        ("shelfLifeDays", json!(3_651)),
        ("defaultBoxTemplateId", json!(unknown)),
        ("defaultPalletTemplateId", json!(unknown)),
    ] {
        let mut body = milk();
        body[field] = value;
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (status, error["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    // A field the host does not keep, or a count that is not one, is refused
    // as a whole.
    for (field, value) in [
        ("egaisCode", json!("0101234567890123456")),
        ("boxCapacity", json!(-1)),
    ] {
        let mut body = milk();
        body[field] = value;
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{field}"
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(audit_trail(&admin.app, "product.create").await.is_empty());
}

/// A default template must be a template of its slot's purpose; that it is
/// enabled and covers the product's group is checked by the office when it
/// is chosen and by the station before it is used, so a template disabled
/// or narrowed later never blocks the product.
#[tokio::test]
async fn a_default_template_is_of_its_slots_purpose_and_stays_a_preference() {
    let admin = admin().await;
    let pallet = insert_template(&admin.app, "pallet", true, None).await;
    let beer_box = insert_template(&admin.app, "box", false, Some("[15]")).await;

    let mut body = milk();
    body["defaultBoxTemplateId"] = json!(pallet);
    let (status, error) = admin
        .call("POST", "/v1/office/products", Some(body.clone()))
        .await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("defaultBoxTemplateId"))
    );
    body["defaultBoxTemplateId"] = json!(beer_box);
    body["defaultPalletTemplateId"] = json!(beer_box);
    let (status, error) = admin
        .call("POST", "/v1/office/products", Some(body.clone()))
        .await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("defaultPalletTemplateId"))
    );
    // A disabled box template scoped to beer stands as the milk product's
    // box preference.
    body["defaultPalletTemplateId"] = json!(pallet);
    let created = create(&admin, body).await;
    assert_eq!(
        (
            created["defaultBoxTemplateId"].clone(),
            created["defaultPalletTemplateId"].clone()
        ),
        (json!(beer_box), json!(pallet))
    );
}

#[tokio::test]
async fn technologists_create_and_change_products() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, created) = admin
        .call_as(&tech, "POST", "/v1/office/products", Some(milk()))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut change = full(&created, created["rev"].as_i64().unwrap());
    change["shelfLifeDays"] = json!(14);
    let (status, updated) = admin
        .call_as(&tech, "PUT", &path(&created), Some(change))
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let (status, list) = admin
        .call_as(&tech, "GET", "/v1/office/products", None)
        .await;
    assert_eq!((status, list), (StatusCode::OK, json!([updated])));
    assert_eq!(
        audit_trail(&admin.app, "product.create").await,
        vec![audit_row(
            &tech_id,
            "product.create",
            "product",
            &id,
            json!({ "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л" })
        )]
    );
    assert_eq!(
        audit_trail(&admin.app, "product.update").await,
        vec![audit_row(
            &tech_id,
            "product.update",
            "product",
            &id,
            json!({ "changed": ["shelfLifeDays"], "shelfLifeDays": { "from": 10, "to": 14 } })
        )]
    );
}

/// Catalog writes read the session and the role again inside their write
/// transaction, as administrator writes do: a session that ended, or a user
/// turned off, after the extractor passed stops the write.
#[tokio::test]
async fn catalog_writes_recheck_the_session_inside_the_transaction() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (_, me) = admin.call_as(&tech, "GET", "/v1/office/me", None).await;
    let (session_id, device_id): (String, String) =
        sqlx::query_as("SELECT id, device_id FROM office_sessions WHERE user_id = ?")
            .bind(&tech_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let context = OfficeContext {
        device_id,
        session_id,
        user: serde_json::from_value(me).unwrap(),
    };
    context.require_catalog().unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    context.require_catalog_in(&mut tx).await.unwrap();
    tx.rollback().await.unwrap();

    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&tech_id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let refused = context.require_catalog_in(&mut tx).await.unwrap_err();
    assert_eq!(
        (
            refused.code(),
            refused.details().unwrap()["credential"].clone()
        ),
        ("unauthorized", json!("session"))
    );
}

#[tokio::test]
async fn an_unknown_product_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/products/9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut invalid = full(&milk_record("x", 1), 1);
    invalid["gtin14"] = json!("1");
    let (status, body) = admin.call("PUT", path, Some(invalid)).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("gtin14"))
    );
    let (status, body) = admin
        .call("PUT", path, Some(full(&milk_record("x", 1), 1)))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
```

9. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// The free-text validators that trim their input, each with the
    /// `details.field` it names.
    fn text_validators() -> [(&'static str, TextCheck); 8] {
        [
            ("name", |text| person_name("name", text).map(drop)),
            ("org.name", |text| {
                company("org", text, None, GLN, &[]).map(drop)
            }),
            ("lines.0", |text| line_name("lines.0", text).map(drop)),
            ("name", |text| device_name("name", text).map(drop)),
            ("name", |text| {
                device_registration(text, "0.1.0", &[]).map(drop)
            }),
```

заменить на

<!-- prettier-ignore -->
```rust
    /// The free-text validators that trim their input, each with the
    /// `details.field` it names.
    fn text_validators() -> [(&'static str, TextCheck); 10] {
        [
            ("name", |text| person_name("name", text).map(drop)),
            ("name", |text| product_name("name", text).map(drop)),
            ("printName", |text| {
                print_name("printName", Some(text)).map(drop)
            }),
            ("org.name", |text| {
                company("org", text, None, GLN, &[]).map(drop)
            }),
            ("lines.0", |text| line_name("lines.0", text).map(drop)),
            ("name", |text| device_name("name", text).map(drop)),
            ("name", |text| {
                device_registration(text, "0.1.0", &[]).map(drop)
            }),
```

10. Там же фрагмент

<!-- prettier-ignore -->
```rust
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

заменить на

<!-- prettier-ignore -->
```rust
            format!("pbkdf2$sha256${iterations}$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=")
        };
        assert!(pin_phc("pinPhc", &phc(100_000)).is_ok());
        assert!(pin_phc("pinPhc", &phc(1_000_000)).is_ok());
        for bad in [phc(9_999), phc(1_000_001), "4821".to_owned(), String::new()] {
            assert_eq!(field(pin_phc("pinPhc", &bad)), "pinPhc", "{bad}");
        }
    }

    #[test]
    fn a_gtin14_is_fourteen_ascii_digits_and_nothing_else() {
        assert_eq!(
            gtin14("gtin14", " 04600682000013 ").unwrap(),
            "04600682000013"
        );
        for bad in [
            "4600682000013",
            "046006820000131",
            "0460068200001X",
            "٠٤٦٠٠٦٨٢٠٠٠٠١٣",
            "",
        ] {
            assert_eq!(field(gtin14("gtin14", bad)), "gtin14", "{bad:?}");
        }
    }

    #[test]
    fn product_names_count_characters_and_a_print_name_may_be_blank() {
        assert!(product_name("name", &"м".repeat(200)).is_ok());
        assert_eq!(field(product_name("name", &"м".repeat(201))), "name");
        assert_eq!(field(product_name("name", " ")), "name");
        assert_eq!(print_name("printName", Some("  ")).unwrap(), None);
        assert_eq!(print_name("printName", None).unwrap(), None);
        assert_eq!(
            print_name("printName", Some(" Молоко "))
                .unwrap()
                .as_deref(),
            Some("Молоко")
        );
        assert_eq!(
            field(print_name("printName", Some(&"м".repeat(201)))),
            "printName"
        );
    }

    #[test]
    fn a_count_is_none_or_one_to_its_bound() {
        assert!(count("boxCapacity", None, MAX_BOX_CAPACITY).is_ok());
        assert!(count("boxCapacity", Some(1), MAX_BOX_CAPACITY).is_ok());
        assert!(count("boxCapacity", Some(MAX_BOX_CAPACITY), MAX_BOX_CAPACITY).is_ok());
        assert_eq!(
            field(count("boxCapacity", Some(0), MAX_BOX_CAPACITY)),
            "boxCapacity"
        );
        assert_eq!(
            field(count(
                "shelfLifeDays",
                Some(MAX_SHELF_LIFE_DAYS + 1),
                MAX_SHELF_LIFE_DAYS
            )),
            "shelfLifeDays"
        );
    }
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test products --offline`
Expected: FAIL — не компилируется: ``error[E0599]: no method named `require_catalog` found for struct `OfficeContext` in the current scope`` (и то же для `require_catalog_in`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: FAIL — не компилируется: ``error[E0425]: cannot find function `gtin14` in this scope``, то же для `product_name`, `print_name`, `count`, `MAX_BOX_CAPACITY` и `MAX_SHELF_LIFE_DAYS`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::OfficeProduct`, `markiro_proto::ProductCreate`, `markiro_proto::ProductUpdate` ``.

- [ ] **Step 3: Права каталога, проверки полей, записи протокола и маршруты товаров**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductGroup {
    pub code: u32,
    pub alias: String,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };
```

заменить на

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductGroup {
    pub code: u32,
    pub alias: String,
    pub name: String,
}

/// A product as the office sees it (`GET /v1/office/products`, archived
/// products included). `status` is computed: `active` with a product group
/// and both capacities, `draft` before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeProduct {
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
    pub status: ProductStatus,
    pub rev: i64,
}

/// `POST /v1/office/products`: a product in use. The office normalized the
/// GTIN with `normalizeToGtin14`; every field after `name` may be left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCreate {
    pub gtin14: String,
    pub name: String,
    #[serde(default)]
    pub print_name: Option<String>,
    #[serde(default)]
    pub chz_product_group_code: Option<u32>,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default)]
    pub shelf_life_days: Option<u32>,
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
}

/// `PUT /v1/office/products/{id}`: every field, like a counterparty, so a
/// field left out or `null` is cleared; `archived: true` archives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductUpdate {
    pub gtin14: String,
    pub name: String,
    #[serde(default)]
    pub print_name: Option<String>,
    #[serde(default)]
    pub chz_product_group_code: Option<u32>,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default)]
    pub shelf_life_days: Option<u32>,
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };
```

2. В `apps/standalone/host/src/auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// `begin_write`, in addition to the early `require_admin` rejection.
    pub async fn require_admin_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError> {
        if self.live_role_in(conn).await? == OfficeRole::Admin {
            Ok(())
        } else {
            Err(ApiError::forbidden("the administrator role is required"))
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
    /// `begin_write`, in addition to the early `require_admin` rejection.
    pub async fn require_admin_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError> {
        if self.live_role_in(conn).await? == OfficeRole::Admin {
            Ok(())
        } else {
            Err(ApiError::forbidden("the administrator role is required"))
        }
    }

    /// The early check of a catalog write: products, label templates and
    /// their defaults (spec §4.8, `editCatalog`).
    pub fn require_catalog(&self) -> Result<(), ApiError> {
        if edits_catalog(self.user.role) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a catalog role is required"))
        }
    }

    /// Re-check catalog rights inside the caller's write transaction, as
    /// [`Self::require_admin_in`] does for administrator writes: a session that
    /// ended, a user turned off or a role taken away since the extractor
    /// read them stops the write.
    pub async fn require_catalog_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError> {
        if edits_catalog(self.live_role_in(conn).await?) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a catalog role is required"))
        }
    }
}

/// Whether a role changes the catalog, label templates and their defaults
/// (spec §4.8: administrators and technologists). No wildcard arm: a new
/// role does not compile until it is placed here.
pub fn edits_catalog(role: OfficeRole) -> bool {
    match role {
        OfficeRole::Admin | OfficeRole::Technologist => true,
    }
}
```

3. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
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

/// A GTIN-14 the office normalized with `normalizeToGtin14`: trimmed,
/// exactly 14 ASCII digits. The check digit and the GS1 prefix are the UI's
/// rules (`@markiro/domain`); the host checks the shape only.
pub fn gtin14(field: &str, gtin14: &str) -> Result<String, ApiError> {
    let gtin14 = gtin14.trim();
    if digits(gtin14, 14..=14) {
        Ok(gtin14.to_owned())
    } else {
        Err(ApiError::validation(field, "the GTIN must be 14 digits"))
    }
}

/// A product's name: trimmed, 1-200 characters, as the cloud's.
pub fn product_name(field: &str, name: &str) -> Result<String, ApiError> {
    clean_text(field, name, 200, "the name").map(str::to_owned)
}

/// A product's short print name (the cloud's `printName`): free text of at
/// most 200 characters, or none.
pub fn print_name(field: &str, name: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, name, 200, "the print name")
}

/// The most units a box holds. The cloud bounds none; this cap only keeps a
/// typing slip out of production.
pub const MAX_BOX_CAPACITY: u32 = 100_000;
/// The most boxes a pallet holds, for the same reason.
pub const MAX_PALLET_BOX_CAPACITY: u32 = 10_000;
/// The longest shelf life in days, the cloud's `shelfLifeDays` bound.
pub const MAX_SHELF_LIFE_DAYS: u32 = 3_650;

/// An optional count: none, or 1 to `max`.
pub fn count(field: &str, value: Option<u32>, max: u32) -> Result<(), ApiError> {
    match value {
        Some(value) if !(1..=max).contains(&value) => {
            Err(ApiError::validation(field, format!("1-{max}, or none")))
        }
        _ => Ok(()),
    }
}
```

4. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const LINE_CREATE: &str = "line.create";
    pub const LINE_UPDATE: &str = "line.update";
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const LINE_CREATE: &str = "line.create";
    pub const LINE_UPDATE: &str = "line.update";
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
}
```

5. Заменить содержимое `apps/standalone/host/src/routes/products.rs` целиком:

<!-- prettier-ignore -->
```rust
//! The catalog (spec §4.3). `GET /v1/office/product-groups` lists the ЧЗ
//! product groups: the cloud's static lookup, read by every office role and
//! written by nobody. Products: `GET /v1/office/products` (every role,
//! archived products included), `POST` and `PUT …/{id}` (administrators and
//! technologists; `PUT` takes every field and `expectedRev`). A product is
//! archived instead of deleted and rides the station feed with its flag.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeProduct, ProductCreate, ProductGroup, ProductUpdate, TemplatePurpose};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

/// `GET /v1/office/product-groups`: every group, by code.
pub async fn list_product_groups(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<ProductGroup>>, ApiError> {
    let rows: Vec<(u32, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(code, alias, name)| ProductGroup { code, alias, name })
            .collect(),
    ))
}

const SELECT: &str = "SELECT id, gtin14, name, print_name, chz_group_code, box_capacity, \
     pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, \
     archived, status, rev FROM products";

#[derive(sqlx::FromRow)]
struct ProductRow {
    id: String,
    gtin14: String,
    name: String,
    print_name: Option<String>,
    chz_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    archived: bool,
    status: String,
    rev: i64,
}

fn record(row: ProductRow) -> Result<OfficeProduct, ApiError> {
    Ok(OfficeProduct {
        id: row.id,
        gtin14: row.gtin14,
        name: row.name,
        print_name: row.print_name,
        chz_product_group_code: row.chz_group_code,
        box_capacity: row.box_capacity,
        pallet_box_capacity: row.pallet_box_capacity,
        shelf_life_days: row.shelf_life_days,
        default_box_template_id: row.default_box_template_id,
        default_pallet_template_id: row.default_pallet_template_id,
        archived: row.archived,
        status: row.status.parse().map_err(ApiError::internal)?,
        rev: row.rev,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeProduct>, ApiError> {
    let row: Option<ProductRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// The fields a create and an update share, as the request sent them.
struct Sent<'a> {
    gtin14: &'a str,
    name: &'a str,
    print_name: Option<&'a str>,
    chz_product_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<&'a str>,
    default_pallet_template_id: Option<&'a str>,
}

impl<'a> From<&'a ProductCreate> for Sent<'a> {
    fn from(create: &'a ProductCreate) -> Self {
        Self {
            gtin14: &create.gtin14,
            name: &create.name,
            print_name: create.print_name.as_deref(),
            chz_product_group_code: create.chz_product_group_code,
            box_capacity: create.box_capacity,
            pallet_box_capacity: create.pallet_box_capacity,
            shelf_life_days: create.shelf_life_days,
            default_box_template_id: create.default_box_template_id.as_deref(),
            default_pallet_template_id: create.default_pallet_template_id.as_deref(),
        }
    }
}

impl<'a> From<&'a ProductUpdate> for Sent<'a> {
    fn from(update: &'a ProductUpdate) -> Self {
        Self {
            gtin14: &update.gtin14,
            name: &update.name,
            print_name: update.print_name.as_deref(),
            chz_product_group_code: update.chz_product_group_code,
            box_capacity: update.box_capacity,
            pallet_box_capacity: update.pallet_box_capacity,
            shelf_life_days: update.shelf_life_days,
            default_box_template_id: update.default_box_template_id.as_deref(),
            default_pallet_template_id: update.default_pallet_template_id.as_deref(),
        }
    }
}

/// The shared fields after validation (trimmed, checked).
struct Fields {
    gtin14: String,
    name: String,
    print_name: Option<String>,
    chz_product_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
}

impl Sent<'_> {
    fn validate(&self) -> Result<Fields, ApiError> {
        let gtin14 = validate::gtin14("gtin14", self.gtin14)?;
        let name = validate::product_name("name", self.name)?;
        let print_name = validate::print_name("printName", self.print_name)?;
        validate::count("boxCapacity", self.box_capacity, validate::MAX_BOX_CAPACITY)?;
        validate::count(
            "palletBoxCapacity",
            self.pallet_box_capacity,
            validate::MAX_PALLET_BOX_CAPACITY,
        )?;
        validate::count(
            "shelfLifeDays",
            self.shelf_life_days,
            validate::MAX_SHELF_LIFE_DAYS,
        )?;
        Ok(Fields {
            gtin14,
            name,
            print_name,
            chz_product_group_code: self.chz_product_group_code,
            box_capacity: self.box_capacity,
            pallet_box_capacity: self.pallet_box_capacity,
            shelf_life_days: self.shelf_life_days,
            default_box_template_id: self.default_box_template_id.map(str::to_owned),
            default_pallet_template_id: self.default_pallet_template_id.map(str::to_owned),
        })
    }
}

/// What the fields refer to exists: the product group, and for each default
/// template a template of the slot's purpose. Whether that template is
/// enabled and covers the product's group is the domain's rule: the office
/// applies it when choosing one and the station before using one, so a
/// template disabled or narrowed later never blocks editing or archiving
/// the product. Deleting a template clears the pointers (`templates`).
async fn check_references(conn: &mut SqliteConnection, fields: &Fields) -> Result<(), ApiError> {
    if let Some(code) = fields.chz_product_group_code {
        let known: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM chz_product_groups WHERE code = ?")
                .bind(code)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        if known.is_none() {
            return Err(ApiError::validation(
                "chzProductGroupCode",
                "no such product group",
            ));
        }
    }
    for (field, id, purpose) in [
        (
            "defaultBoxTemplateId",
            &fields.default_box_template_id,
            TemplatePurpose::Box,
        ),
        (
            "defaultPalletTemplateId",
            &fields.default_pallet_template_id,
            TemplatePurpose::Pallet,
        ),
    ] {
        let Some(id) = id else {
            continue;
        };
        let found: Option<String> =
            sqlx::query_scalar("SELECT purpose FROM label_templates WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        if found.as_deref() != Some(purpose.as_str()) {
            return Err(ApiError::validation(
                field,
                format!("a {} template is required", purpose.as_str()),
            ));
        }
    }
    Ok(())
}

/// A write that hit `products_active_gtin14`: another product in use has
/// the GTIN.
fn gtin_taken(error: sqlx::Error) -> ApiError {
    ApiError::conflict_on_unique_violation(error, "gtin14", "another product in use has this GTIN")
}

pub async fn list_products(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<OfficeProduct>>, ApiError> {
    let rows: Vec<ProductRow> = sqlx::query_as(&format!("{SELECT} ORDER BY archived, name, id"))
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn create_product(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<ProductCreate>,
) -> Result<Json<OfficeProduct>, ApiError> {
    context.require_catalog()?;
    let fields = Sent::from(&create).validate()?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_references(&mut tx, &fields).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
         pallet_box_capacity, shelf_life_days, default_box_template_id, \
         default_pallet_template_id, archived, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&fields.gtin14)
    .bind(&fields.name)
    .bind(&fields.print_name)
    .bind(fields.chz_product_group_code)
    .bind(fields.box_capacity)
    .bind(fields.pallet_box_capacity)
    .bind(fields.shelf_life_days)
    .bind(&fields.default_box_template_id)
    .bind(&fields.default_pallet_template_id)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(gtin_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PRODUCT_CREATE,
            target_type: Some("product"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "gtin14": fields.gtin14, "name": fields.name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("product vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_product(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<ProductUpdate>,
) -> Result<Json<OfficeProduct>, ApiError> {
    context.require_catalog()?;
    let fields = Sent::from(&update).validate()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_references(&mut tx, &fields).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such product"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let Some(details) = audit::update_details(&[
        ("gtin14", json!(current.gtin14), json!(fields.gtin14)),
        ("name", json!(current.name), json!(fields.name)),
        (
            "printName",
            json!(current.print_name),
            json!(fields.print_name),
        ),
        (
            "chzProductGroupCode",
            json!(current.chz_product_group_code),
            json!(fields.chz_product_group_code),
        ),
        (
            "boxCapacity",
            json!(current.box_capacity),
            json!(fields.box_capacity),
        ),
        (
            "palletBoxCapacity",
            json!(current.pallet_box_capacity),
            json!(fields.pallet_box_capacity),
        ),
        (
            "shelfLifeDays",
            json!(current.shelf_life_days),
            json!(fields.shelf_life_days),
        ),
        (
            "defaultBoxTemplateId",
            json!(current.default_box_template_id),
            json!(fields.default_box_template_id),
        ),
        (
            "defaultPalletTemplateId",
            json!(current.default_pallet_template_id),
            json!(fields.default_pallet_template_id),
        ),
        ("archived", json!(current.archived), json!(update.archived)),
    ]) else {
        // Nothing actually changed: report the product as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE products SET gtin14 = ?, name = ?, print_name = ?, chz_group_code = ?, \
         box_capacity = ?, pallet_box_capacity = ?, shelf_life_days = ?, \
         default_box_template_id = ?, default_pallet_template_id = ?, archived = ?, rev = ? \
         WHERE id = ?",
    )
    .bind(&fields.gtin14)
    .bind(&fields.name)
    .bind(&fields.print_name)
    .bind(fields.chz_product_group_code)
    .bind(fields.box_capacity)
    .bind(fields.pallet_box_capacity)
    .bind(fields.shelf_life_days)
    .bind(&fields.default_box_template_id)
    .bind(&fields.default_pallet_template_id)
    .bind(update.archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(gtin_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PRODUCT_UPDATE,
            target_type: Some("product"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("product vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

6. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/badge-salt",
            get(crate::routes::operators::badge_salt),
        )
        .route(
            "/v1/office/product-groups",
            get(crate::routes::products::list_product_groups),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
```

заменить на

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/badge-salt",
            get(crate::routes::operators::badge_salt),
        )
        .route(
            "/v1/office/product-groups",
            get(crate::routes::products::list_product_groups),
        )
        .route(
            "/v1/office/products",
            get(crate::routes::products::list_products)
                .post(crate::routes::products::create_product),
        )
        .route(
            "/v1/office/products/{id}",
            put(crate::routes::products::update_product),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test products --offline`
Expected: PASS — 8 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: PASS — 29 тестов (26 прежних и 3 новых).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 5 модульных тестов и 31 тест фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
  every password (`rules.passwordCharacter`), and the sign-in's login.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
  password; re-checking inside the transaction stops a write a demotion or
  deactivation ended in that window. Self-service writes any office user may
  make on their own record (their own password) re-check the same way with
  `OfficeContext::require_session_in` instead; admin writes keep using
  `require_admin_in`.

## Change feed
```

заменить на

<!-- prettier-ignore -->
```text
  every password (`rules.passwordCharacter`), and the sign-in's login.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
  password; re-checking inside the transaction stops a write a demotion or
  deactivation ended in that window. Self-service writes any office user may
  make on their own record (their own password) re-check the same way with
  `OfficeContext::require_session_in` instead; admin writes keep using
  `require_admin_in`. Catalog writes — products, label templates and their
  defaults, which administrators and technologists make (spec §4.8,
  `editCatalog`) — check `require_catalog` early and `require_catalog_in`
  inside the transaction; `auth::edits_catalog` names the roles, with no
  wildcard arm, so a new role does not compile until it is placed.

## Change feed
```

2. Там же фрагмент

<!-- prettier-ignore -->
```text
The ЧЗ product groups are the cloud's static lookup: host migration `0008`
copies the 51 rows of `packages/db/migrations/0099_chz_product_groups.sql`,
and `host/tests/product_groups.rs` reads that file and compares the rows, so
the copies cannot drift. Every office role reads them
(`GET /v1/office/product-groups`, by code); nothing writes them, and they
are not in the station feed.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
The ЧЗ product groups are the cloud's static lookup: host migration `0008`
copies the 51 rows of `packages/db/migrations/0099_chz_product_groups.sql`,
and `host/tests/product_groups.rs` reads that file and compares the rows, so
the copies cannot drift. Every office role reads them
(`GET /v1/office/product-groups`, by code); nothing writes them, and they
are not in the station feed.

Products (`GET/POST/PUT /v1/office/products`): every office role reads
them, archived ones included (by `archived, name, id`, bytewise as lines);
administrators and technologists write them. `PUT` takes every field with
`expectedRev`, as a counterparty's, so a field left out is cleared;
archiving is `archived: true`, and a product is never deleted. The host
checks `gtin14` for its shape only — 14 ASCII digits after trimming; the
check digit and the prefix are the UI's (`normalizeToGtin14`,
`gtinMatchesPrefix`) — and keeps it unique among products in use
(`products_active_gtin14`: `conflict` on `gtin14` when a product is
created, its GTIN changed or it comes back from the archive); an archived
product keeps its GTIN without reserving it. `status` is a generated column
(`active` with a product group and both capacities, `draft` before, as the
cloud's `computeStatus`) that nobody sends. A name is 1–200 characters, a
print name up to 200 or none, a box holds 1–100 000 units and a pallet
1–10 000 boxes (`MAX_BOX_CAPACITY`, `MAX_PALLET_BOX_CAPACITY`: the cloud caps
neither, so these only keep a typing slip out of production), a shelf life
is 1–3650 days (the cloud's bound), and a product group must exist. The
default box and pallet templates are preferences: the host checks that each
names a template of the slot's purpose; whether that template is enabled
and covers the product's group is the domain's rule, which the office
applies when it offers templates and the station before it uses one, so a
template disabled or narrowed later never blocks editing or archiving the
product. (The cloud has no per-product template since its 2026-09-02 spec;
these follow the stage-1 spec.) National-catalog links, photos, EGAIS
codes, prices and default counterparties are not part of the standalone
catalog yet.

## Reference sync
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
  ничего не меняет.
- `chz_product_groups(code PRIMARY KEY, alias UNIQUE, name)` — 51 строка из облачной
  миграции `0099`, перенесённая миграцией хоста `0008` строка в строку; тест
  `host/tests/product_groups.rs` читает облачный файл и сверяет строки, поэтому
  копии не разойдутся. Читают все роли (`GET /v1/office/product-groups`, по коду),
  не пишет никто; в ленту станций справочник не входит.
- `products(id, gtin14 CHECK(length=14 AND цифры), name, print_name, chz_group_code REFERENCES chz_product_groups, box_capacity, pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status GENERATED ALWAYS AS (CASE WHEN chz_group_code IS NOT NULL AND box_capacity IS NOT NULL AND pallet_box_capacity IS NOT NULL THEN 'active' ELSE 'draft' END) VIRTUAL, rev)`;
  частичный уникальный индекс `gtin14` среди неархивных (как `products_tenant_gtin_unarchived_uq`).
  Ссылки на шаблоны — `ON DELETE SET NULL`.
- `label_templates(id, name, purpose CHECK(purpose IN ('box','pallet','product_duplicate')), enabled, category_codes JSON, spec JSON, stock, rev)`;
  `spec` хранится как текст JSON до 256 КБ, его схему проверяет интерфейс
  (`labelTemplateSpecSchema`).
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))`.
  Хост не даёт удалить или выключить шаблон, который стоит по умолчанию у
  организации или категории (`template_is_default`).
- `audit_log(id, at, actor_kind CHECK(actor_kind IN ('office_user','device','system')), actor_id, action, target_type, target_id, result, details JSON)`.
```

заменить на

<!-- prettier-ignore -->
```text
  ничего не меняет.
- `chz_product_groups(code PRIMARY KEY, alias UNIQUE, name)` — 51 строка из облачной
  миграции `0099`, перенесённая миграцией хоста `0008` строка в строку; тест
  `host/tests/product_groups.rs` читает облачный файл и сверяет строки, поэтому
  копии не разойдутся. Читают все роли (`GET /v1/office/product-groups`, по коду),
  не пишет никто; в ленту станций справочник не входит.
- `products(id, gtin14 CHECK(length=14 AND цифры), name, print_name, chz_group_code REFERENCES chz_product_groups, box_capacity, pallet_box_capacity, shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status GENERATED ALWAYS AS (CASE WHEN chz_group_code IS NOT NULL AND box_capacity IS NOT NULL AND pallet_box_capacity IS NOT NULL THEN 'active' ELSE 'draft' END) VIRTUAL, rev)`;
  частичный уникальный индекс `gtin14` среди неархивных (как `products_tenant_gtin_unarchived_uq`).
  Ссылки на шаблоны — `ON DELETE SET NULL`. Правила плана 1e1: хост проверяет у
  `gtin14` только вид — 14 цифр ASCII после обрезки (контрольную цифру и префикс
  проверяет интерфейс: `normalizeToGtin14`, `gtinMatchesPrefix`); повтор среди
  неархивных — `conflict` с `constraint: gtin14` при создании, смене GTIN и
  возврате из архива. Имя — 1–200 символов, имя для печати — до 200 или пусто,
  в коробе 1–100 000 штук, на паллете 1–10 000 коробов (в облаке потолка нет,
  этот лишь не пускает опечатку), срок годности 1–3650 дней (граница облака),
  товарная группа должна существовать. `PUT` несёт все поля и `expectedRev`, как
  у контрагента; архив — `archived: true`, удаления нет. Шаблоны товара по
  умолчанию — пожелания: хост проверяет только, что шаблон есть и его назначение
  совпадает со слотом; включён ли он и покрывает ли группу товара, проверяют
  интерфейс при выборе и станция перед печатью, поэтому шаблон, выключенный или
  суженный позже, не мешает править и архивировать товар. Удаление шаблона
  снимает ссылки сам хост (товар получает новую ревизию и едет по ленте), а
  `ON DELETE SET NULL` остаётся страховкой. В облаке шаблона на товар нет со
  спецификации 2026-09-02; эти ссылки — решение этапа 1. Поля Нацкаталога, фото,
  ЕГАИС, цены и контрагент по умолчанию в каталог автономного продукта пока не
  входят.
- `label_templates(id, name, purpose CHECK(purpose IN ('box','pallet','product_duplicate')), enabled, category_codes JSON, spec JSON, stock, rev)`;
  `spec` хранится как текст JSON до 256 КБ, его схему проверяет интерфейс
  (`labelTemplateSpecSchema`).
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))`.
  Хост не даёт удалить или выключить шаблон, который стоит по умолчанию у
  организации или категории (`template_is_default`).
- `audit_log(id, at, actor_kind CHECK(actor_kind IN ('office_user','device','system')), actor_id, action, target_type, target_id, result, details JSON)`.
```

4. Там же фрагмент

<!-- prettier-ignore -->
```text
Формат: HTTP-статус и тело `{ "error": { "code": "<snake_case>", "message": "<для журнала>", "details": { … } } }`.
Интерфейс показывает текст по коду через i18n, `message` пользователю не выводится.
Коды этапа: `unauthorized` (с `details.credential` — какой признак не прошёл
проверку: `device` — приложение предлагает переподключить это устройство,
`session` — войти в офис заново, `password` — показывает текст под неверный
логин или пароль), `forbidden`, `not_found`, `method_not_allowed`, `validation_failed` (с полями
в `details`), `stale_revision`, `conflict` (с `details.constraint`: `gtin`, `login`,
`badge`, `line_name`; у `badge` ещё `details.operatorId` — оператор, у которого этот
бейдж уже есть, когда хост нашёл владельца (иначе ключа нет): маршрут только для
администраторов, а они видят всех операторов),
`template_is_default`, `last_admin`, `sscc_below_floor`,
`pairing_code_invalid`, `pairing_code_expired`, `already_initialized`,
`loopback_only`, `protocol_unsupported`, `rate_limited`, `internal`.
```

заменить на

<!-- prettier-ignore -->
```text
Формат: HTTP-статус и тело `{ "error": { "code": "<snake_case>", "message": "<для журнала>", "details": { … } } }`.
Интерфейс показывает текст по коду через i18n, `message` пользователю не выводится.
Коды этапа: `unauthorized` (с `details.credential` — какой признак не прошёл
проверку: `device` — приложение предлагает переподключить это устройство,
`session` — войти в офис заново, `password` — показывает текст под неверный
логин или пароль), `forbidden`, `not_found`, `method_not_allowed`, `validation_failed` (с полями
в `details`), `stale_revision`, `conflict` (с `details.constraint`: `gtin14`, `login`,
`badge`, `line_name`; у `badge` ещё `details.operatorId` — оператор, у которого этот
бейдж уже есть, когда хост нашёл владельца (иначе ключа нет): маршрут только для
администраторов, а они видят всех операторов),
`template_is_default`, `last_admin`, `sscc_below_floor`,
`pairing_code_invalid`, `pairing_code_expired`, `already_initialized`,
`loopback_only`, `protocol_unsupported`, `rate_limited`, `internal`.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/office-product.json apps/standalone/proto/fixtures/product-create.json apps/standalone/proto/fixtures/product-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline`
Expected: PASS — 263 теста.

```bash
git add apps/standalone/host/src/auth.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/routes/products.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/products.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-product.json apps/standalone/proto/fixtures/product-create.json apps/standalone/proto/fixtures/product-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): права каталога и товары — GET/POST/PUT /v1/office/products" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Шаблоны — `GET/POST/PUT/DELETE /v1/office/templates`, типовые шаблоны, отказ `template_is_default`

Шаблоны читают все роли: список — сводками без макета, как облачный `LabelTemplateSummaryDto` (размер, разрешение и язык читаются из сохранённого `spec` как есть, `null`, где значения нужного типа нет: хост макет не проверяет), `GET …/{id}` — шаблон с макетом. Пишут администратор и технолог. Хост держит `spec` объектом JSON не больше 256 КБ в компактной записи и не проверяет его схему. Назначение не меняется: у `LabelTemplateUpdate` нет поля `purpose`. `PUT` меняет только присланное, с `expectedRev`; `chzProductGroupCodes: null` расширяет шаблон до всех категорий, отсутствие поля категории оставляет.

Правила облака (`label-templates.service.ts`) переносятся с одной проверкой слота: модуль `host/src/templates.rs` держит `fits` (включённый шаблон своего назначения, покрывающий категорию; слот организации — все категории), `usage` (чьим умолчанием стоит шаблон) и отказ `template_is_default` с `organizationDefault` и `categoryDefaults`, как `LABEL_TEMPLATE_IS_DEFAULT`. Общая фикстура `template-eligibility.json` закрепляет ответы `fits`; план 1e2 сверит с ней правило домена. Типовой шаблон (решение 5) не меняет имени и макета и не удаляется — `stock_template`; выключить и сузить его можно. Удаление шаблона, который не умолчание, снимает ссылки товаров с ревизией удаления и пишет надгробие; повторное удаление после потерянного ответа находит надгробие и отвечает 204.

Умолчания и типовой шаблон тесты этой задачи пишут прямо в таблицы: маршрут умолчаний — задача 5, типовые шаблоны мастера — задача 6.

**Files:**

- Create: `apps/standalone/host/src/templates.rs`, `apps/standalone/host/src/routes/templates.rs`, `apps/standalone/proto/fixtures/template-summary.json`, `label-template.json`, `template-create.json`, `template-update.json`, `template-eligibility.json`, `error-template-is-default.json`
- Modify: `apps/standalone/host/src/{lib,validate,audit,server}.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/templates.rs` (Create), `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/validate.rs` (модуль `tests`)
- Modify: `apps/standalone/AGENTS.md` («Audit», «Catalog and label templates»), спецификация §4.3, §4.6

**Interfaces:**

- Consumes:
  - `OfficeContext::{require_catalog, require_catalog_in}`, `clean_text` (задача 3);
  - `feed::remove`, `entities::LABEL_TEMPLATES`, `TemplatePurpose` (задача 2);
  - `audit::{record, update_details_hiding, Entry, Outcome}`;
  - таблицы `label_templates`, `category_template_defaults`, `products`, столбцы шаблонов `org_profile` (задача 1);
  - `admin`, `Admin::{call, call_as, row, feed, technologist_session}`, `audit_row`, `audit_trail`, `audit_rows`, `host_revision`, `TestApp` — `host/tests/support/app.rs`.
- Produces:
  - `pub struct templates::Scope { purpose, enabled, codes: Option<Vec<u32>> }`, `pub fn templates::fits(&Scope, TemplatePurpose, Option<u32>) -> bool`, `pub async fn templates::check_groups(conn, field, codes: Option<&[u32]>) -> Result<(), ApiError>`, `pub fn templates::org_column(TemplatePurpose) -> &'static str`, `pub struct templates::Usage { organization: bool, categories: Vec<u32> }`, `pub async fn templates::usage(conn, id, purpose) -> Result<Usage, ApiError>`, `pub fn templates::is_default(bool, Vec<u32>) -> ApiError`;
  - `validate::{template_name, template_spec, category_codes}`, `MAX_SPEC_BYTES = 256 * 1024`, `MAX_CATEGORY_CODES = 100`;
  - `actions::{TEMPLATE_CREATE, TEMPLATE_UPDATE, TEMPLATE_DELETE}`;
  - `LabelTemplateSummary`, `LabelTemplate`, `LabelTemplateCreate`, `LabelTemplateUpdate` — `proto/src/lib.rs`;
  - `routes::templates::{list_templates, get_template, create_template, update_template, delete_template}`;
  - фикстуры шаблонов, общая `template-eligibility.json` и `error-template-is-default.json`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/error-template-is-default.json`:

<!-- prettier-ignore -->
```json
{
  "error": {
    "code": "conflict",
    "message": "the template is a default that the change would break",
    "details": {
      "constraint": "template_is_default",
      "organizationDefault": true,
      "categoryDefaults": [8, 15]
    }
  }
}
```

2. Create `apps/standalone/proto/fixtures/label-template.json`:

<!-- prettier-ignore -->
```json
{
  "id": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "name": "Молоко 58×40",
  "purpose": "box",
  "enabled": true,
  "chzProductGroupCodes": [8],
  "stock": false,
  "spec": {
    "widthMm": 58,
    "heightMm": 40,
    "dpi": 203,
    "language": "tspl",
    "elements": [
      {
        "kind": "field",
        "id": "name",
        "xMm": 2,
        "yMm": 2,
        "field": "product.printName",
        "fontSizePt": 10
      }
    ]
  },
  "rev": 62
}
```

3. Create `apps/standalone/proto/fixtures/template-create.json`:

<!-- prettier-ignore -->
```json
{
  "name": "Молоко 58×40",
  "purpose": "box",
  "enabled": true,
  "chzProductGroupCodes": null,
  "spec": {
    "widthMm": 58,
    "heightMm": 40,
    "dpi": 203,
    "language": "tspl",
    "elements": [
      {
        "kind": "field",
        "id": "name",
        "xMm": 2,
        "yMm": 2,
        "field": "product.printName",
        "fontSizePt": 10
      }
    ]
  }
}
```

4. Create `apps/standalone/proto/fixtures/template-eligibility.json`:

<!-- prettier-ignore -->
```json
{
  "cases": [
    {
      "template": { "purpose": "box", "enabled": true, "chzProductGroupCodes": null },
      "slot": { "purpose": "box", "chzProductGroupCode": null },
      "fits": true
    },
    {
      "template": { "purpose": "box", "enabled": false, "chzProductGroupCodes": null },
      "slot": { "purpose": "box", "chzProductGroupCode": null },
      "fits": false
    },
    {
      "template": { "purpose": "box", "enabled": true, "chzProductGroupCodes": [8] },
      "slot": { "purpose": "box", "chzProductGroupCode": null },
      "fits": false
    },
    {
      "template": { "purpose": "box", "enabled": true, "chzProductGroupCodes": [8] },
      "slot": { "purpose": "box", "chzProductGroupCode": 8 },
      "fits": true
    },
    {
      "template": { "purpose": "box", "enabled": true, "chzProductGroupCodes": [8] },
      "slot": { "purpose": "box", "chzProductGroupCode": 15 },
      "fits": false
    },
    {
      "template": { "purpose": "box", "enabled": true, "chzProductGroupCodes": null },
      "slot": { "purpose": "box", "chzProductGroupCode": 15 },
      "fits": true
    },
    {
      "template": { "purpose": "pallet", "enabled": true, "chzProductGroupCodes": null },
      "slot": { "purpose": "box", "chzProductGroupCode": null },
      "fits": false
    },
    {
      "template": { "purpose": "pallet", "enabled": true, "chzProductGroupCodes": null },
      "slot": { "purpose": "pallet", "chzProductGroupCode": null },
      "fits": true
    },
    {
      "template": { "purpose": "pallet", "enabled": true, "chzProductGroupCodes": [8, 15] },
      "slot": { "purpose": "pallet", "chzProductGroupCode": 15 },
      "fits": true
    },
    {
      "template": { "purpose": "product_duplicate", "enabled": true, "chzProductGroupCodes": null },
      "slot": { "purpose": "product_duplicate", "chzProductGroupCode": null },
      "fits": true
    },
    {
      "template": {
        "purpose": "product_duplicate",
        "enabled": false,
        "chzProductGroupCodes": [15]
      },
      "slot": { "purpose": "product_duplicate", "chzProductGroupCode": 15 },
      "fits": false
    },
    {
      "template": { "purpose": "box", "enabled": true, "chzProductGroupCodes": [8] },
      "slot": { "purpose": "pallet", "chzProductGroupCode": 8 },
      "fits": false
    }
  ]
}
```

5. Create `apps/standalone/proto/fixtures/template-summary.json`:

<!-- prettier-ignore -->
```json
{
  "id": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "name": "Молоко 58×40",
  "purpose": "box",
  "enabled": true,
  "chzProductGroupCodes": [8],
  "stock": false,
  "widthMm": 58,
  "heightMm": 40,
  "dpi": 203,
  "language": "tspl",
  "rev": 62
}
```

6. Create `apps/standalone/proto/fixtures/template-update.json`:

<!-- prettier-ignore -->
```json
{ "enabled": false, "chzProductGroupCodes": [8, 15], "expectedRev": 62 }
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope,
    LabelTemplateRecord, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeUser,
    OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate,
    OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, SiteRecord, SsccCounterUpdate, SsccState,
    TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LabelTemplate,
    LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary, LabelTemplateUpdate,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate,
    OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord,
    OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode,
    PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup, ProductRecord,
    ProductStatus, ProductUpdate, SiteRecord, SsccCounterUpdate, SsccState, TemplatePurpose,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

8. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn template_fixtures_round_trip_and_a_purpose_is_never_an_update_field() {
    let summary: LabelTemplateSummary = round_trip("template-summary.json");
    assert_eq!(
        (summary.dpi, summary.language.as_deref()),
        (Some(203), Some("tspl"))
    );
    let template: LabelTemplate = round_trip("label-template.json");
    assert_eq!(template.id, summary.id);
    assert_eq!(
        template.spec["widthMm"],
        serde_json::to_value(&summary.width_mm).unwrap()
    );
    let create: LabelTemplateCreate = round_trip("template-create.json");
    assert_eq!(create.chz_product_group_codes, None);
    let update: LabelTemplateUpdate = round_trip("template-update.json");
    assert_eq!(update.chz_product_group_codes, Some(Some(vec![8, 15])));
    // `null` widens a template to every category; leaving the field out keeps
    // its categories.
    let widen: LabelTemplateUpdate = serde_json::from_value(
        serde_json::json!({ "chzProductGroupCodes": null, "expectedRev": 62 }),
    )
    .unwrap();
    assert_eq!(widen.chz_product_group_codes, Some(None));
    let keep: LabelTemplateUpdate =
        serde_json::from_value(serde_json::json!({ "enabled": false, "expectedRev": 62 })).unwrap();
    assert_eq!(keep.chz_product_group_codes, None);
    // A purpose never changes, and no request makes a stock template.
    let mut value = fixture("template-update.json");
    value["purpose"] = Value::String("pallet".into());
    assert!(serde_json::from_value::<LabelTemplateUpdate>(value).is_err());
    let mut value = fixture("template-create.json");
    value["stock"] = Value::Bool(true);
    assert!(serde_json::from_value::<LabelTemplateCreate>(value).is_err());
    // A refusal names the defaults that stand in the way.
    let refused: ErrorBody = round_trip("error-template-is-default.json");
    let details = refused.error.details.expect("details");
    assert_eq!(
        (
            details["constraint"].as_str(),
            details["organizationDefault"].as_bool()
        ),
        (Some("template_is_default"), Some(true))
    );
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

9. Create `apps/standalone/host/tests/templates.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use markiro_host::templates::{fits, Scope};
use markiro_proto::TemplatePurpose;
use serde_json::{json, Value};
use support::app::{admin, audit_row, audit_rows, audit_trail, host_revision, Admin, TestApp};

/// `proto/fixtures/template-eligibility.json` holds the cases the host's
/// rule and the domain's must answer alike; plan 1e2 reads it in Vitest.
#[test]
fn the_eligibility_fixture_matches_fits() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../proto/fixtures/template-eligibility.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let fixture: Value = serde_json::from_str(&text).unwrap();
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 12);
    for case in cases {
        let template = &case["template"];
        let scope = Scope {
            purpose: serde_json::from_value(template["purpose"].clone()).unwrap(),
            enabled: template["enabled"].as_bool().unwrap(),
            codes: serde_json::from_value(template["chzProductGroupCodes"].clone()).unwrap(),
        };
        let slot = &case["slot"];
        let purpose: TemplatePurpose = serde_json::from_value(slot["purpose"].clone()).unwrap();
        let category: Option<u32> =
            serde_json::from_value(slot["chzProductGroupCode"].clone()).unwrap();
        assert_eq!(
            fits(&scope, purpose, category),
            case["fits"].as_bool().unwrap(),
            "{case}"
        );
    }
}

/// A small layout, as the office's editor saves one.
fn layout() -> Value {
    json!({ "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] })
}

async fn create(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", "/v1/office/templates", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

fn box_template(name: &str) -> Value {
    json!({ "name": name, "purpose": "box", "enabled": true, "spec": layout() })
}

fn path(template: &Value) -> String {
    format!("/v1/office/templates/{}", template["id"].as_str().unwrap())
}

fn error(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

/// A stock template as the wizard leaves one, written straight into its
/// table; returns its id and revision.
async fn insert_stock(app: &TestApp) -> (String, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, spec, stock, rev) \
         VALUES (?, 'Коробка 58×40', 'box', 1, ?, 1, ?)",
    )
    .bind(&id)
    .bind(layout().to_string())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (id, rev)
}

#[tokio::test]
async fn templates_are_created_listed_read_and_updated() {
    let admin = admin().await;
    let created = create(&admin, box_template(" Молоко 58×40 ")).await;
    let id = created["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1.
    assert_eq!(
        created,
        json!({
            "id": id, "name": "Молоко 58×40", "purpose": "box", "enabled": true,
            "chzProductGroupCodes": null, "stock": false, "spec": layout(), "rev": 2
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "template.create").await,
        vec![admin.row(
            "template.create",
            "template",
            &id,
            json!({ "name": "Молоко 58×40", "purpose": "box" })
        )]
    );
    // The list carries summaries...
    let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list,
        json!([{
            "id": id, "name": "Молоко 58×40", "purpose": "box", "enabled": true,
            "chzProductGroupCodes": null, "stock": false,
            "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "rev": 2
        }])
    );
    // ...and one template its layout.
    let (status, read) = admin.call("GET", &path(&created), None).await;
    assert_eq!((status, read), (StatusCode::OK, created.clone()));
    // Stations get the layout as JSON.
    assert_eq!(
        admin.feed(1).await,
        json!([{
            "entity": "label_templates", "id": id, "rev": 2, "deleted": false,
            "data": {
                "name": "Молоко 58×40", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": null, "stock": false, "spec": layout()
            }
        }])
    );

    let (status, renamed) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "name": "Молоко и кефир 58×40", "chzProductGroupCodes": [8, 15], "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        (
            renamed["name"].clone(),
            renamed["chzProductGroupCodes"].clone(),
            renamed["rev"].clone()
        ),
        (json!("Молоко и кефир 58×40"), json!([8, 15]), json!(3))
    );
    // A new layout is named in the audit row, never written there.
    let mut wider = layout();
    wider["widthMm"] = json!(75);
    let (status, widened) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "spec": wider, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{widened}");
    assert_eq!(
        (widened["spec"].clone(), widened["rev"].clone()),
        (wider.clone(), json!(4))
    );
    assert_eq!(
        audit_trail(&admin.app, "template.update").await,
        vec![
            admin.row(
                "template.update",
                "template",
                &id,
                json!({
                    "changed": ["name", "chzProductGroupCodes"],
                    "name": { "from": "Молоко 58×40", "to": "Молоко и кефир 58×40" },
                    "chzProductGroupCodes": { "from": null, "to": [8, 15] }
                })
            ),
            admin.row(
                "template.update",
                "template",
                &id,
                json!({ "changed": ["spec"] })
            ),
        ]
    );

    // The same values again change nothing.
    let (status, same) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "name": " Молоко и кефир 58×40 ", "enabled": true, "spec": wider, "expectedRev": 4 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, widened));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_trail(&admin.app, "template.update").await.len(), 2);
    // An update over an old revision is refused and writes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": 3 })),
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
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// The host keeps a layout it does not understand: the summary reads what
/// the stored spec holds, `null` where it has nothing of the right type.
#[tokio::test]
async fn a_summary_reads_the_layout_as_it_stands() {
    let admin = admin().await;
    create(
        &admin,
        json!({
            "name": "Черновик", "purpose": "pallet", "enabled": false,
            "spec": { "widthMm": 58.5, "dpi": "203", "language": 7 }
        }),
    )
    .await;
    let (_, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(
        (
            list[0]["widthMm"].clone(),
            list[0]["heightMm"].clone(),
            list[0]["dpi"].clone(),
            list[0]["language"].clone()
        ),
        (json!(58.5), Value::Null, Value::Null, Value::Null)
    );
}

#[tokio::test]
async fn template_fields_are_checked() {
    let admin = admin().await;
    for (field, value) in [
        ("name", json!(" ")),
        ("name", json!("ш".repeat(201))),
        ("name", json!("Коробка\t58×40")),
        ("chzProductGroupCodes", json!([])),
        ("chzProductGroupCodes", json!([8, 8])),
        // 18 is not a ЧЗ product group.
        ("chzProductGroupCodes", json!([8, 18])),
        ("spec", json!([])),
        ("spec", json!("{}")),
        ("spec", json!({ "filler": "x".repeat(262_144) })),
    ] {
        let mut body = box_template("Коробка 58×40");
        body[field] = value;
        let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    // An unknown purpose, or a field no request sets, is refused as a whole.
    for (field, value) in [("purpose", json!("label")), ("stock", json!(true))] {
        let mut body = box_template("Коробка 58×40");
        body[field] = value;
        let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{field}"
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM label_templates")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(audit_trail(&admin.app, "template.create").await.is_empty());
}

#[tokio::test]
async fn a_purpose_never_changes() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "purpose": "pallet", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let (_, read) = admin.call("GET", &path(&created), None).await;
    assert_eq!(read, created);
}

#[tokio::test]
async fn a_stock_template_keeps_its_name_and_layout_and_is_never_deleted() {
    let admin = admin().await;
    let (stock, rev) = insert_stock(&admin.app).await;
    let stock_path = format!("/v1/office/templates/{stock}");
    let rows = audit_rows(&admin.app).await;
    for change in [
        json!({ "name": "Моя коробка", "expectedRev": rev }),
        json!({ "spec": { "widthMm": 75 }, "expectedRev": rev }),
    ] {
        let (status, body) = admin.call("PUT", &stock_path, Some(change)).await;
        assert_eq!(
            (status, body["error"]["details"]["constraint"].clone()),
            (StatusCode::CONFLICT, json!("stock_template"))
        );
    }
    let (status, body) = admin.call("DELETE", &stock_path, None).await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("stock_template"))
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // It may be disabled and narrowed, its own name and layout sent along.
    let (status, narrowed) = admin
        .call(
            "PUT",
            &stock_path,
            Some(json!({
                "name": "Коробка 58×40", "spec": layout(), "enabled": false,
                "chzProductGroupCodes": [8], "expectedRev": rev
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{narrowed}");
    assert_eq!(
        (
            narrowed["enabled"].clone(),
            narrowed["chzProductGroupCodes"].clone(),
            narrowed["stock"].clone()
        ),
        (json!(false), json!([8]), json!(true))
    );
    assert_eq!(
        audit_trail(&admin.app, "template.update").await,
        vec![admin.row(
            "template.update",
            "template",
            &stock,
            json!({
                "changed": ["enabled", "chzProductGroupCodes"],
                "enabled": { "from": true, "to": false },
                "chzProductGroupCodes": { "from": null, "to": [8] }
            })
        )]
    );
    // A copy of its layout is an ordinary template.
    let copy = create(&admin, box_template("Коробка 58×40 (копия)")).await;
    assert_eq!(copy["stock"], json!(false));
}

#[tokio::test]
async fn a_default_is_never_disabled_narrowed_out_of_its_category_or_deleted() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let id = created["id"].as_str().unwrap().to_owned();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE org_profile SET default_box_template_id = ?, rev = ? WHERE id = 1")
        .bind(&id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    for code in [15, 8] {
        sqlx::query(
            "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
             VALUES (?, 'box', ?, ?)",
        )
        .bind(code)
        .bind(&id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let rows = audit_rows(&admin.app).await;

    let refusal = |organization: bool, categories: Value| {
        (
            json!("conflict"),
            json!({ "constraint": "template_is_default", "organizationDefault": organization, "categoryDefaults": categories }),
        )
    };
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(true, json!([8, 15])))
    );
    // The organization's default must cover every category.
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": [8], "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(true, json!([15])))
    );
    let (status, body) = admin.call("DELETE", &path(&created), None).await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(true, json!([8, 15])))
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // Without the organization's default, the template may narrow to the
    // categories it serves, but not out of one.
    sqlx::query("UPDATE org_profile SET default_box_template_id = NULL WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, narrowed) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": [8, 15], "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{narrowed}");
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": [8], "expectedRev": narrowed["rev"] })),
        )
        .await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(false, json!([15])))
    );
}

#[tokio::test]
async fn deleting_a_template_clears_the_products_that_name_it() {
    let admin = admin().await;
    let boxes = create(&admin, box_template("Коробка 58×40")).await;
    let pallets = create(
        &admin,
        json!({ "name": "Паллета 100×150", "purpose": "pallet", "enabled": true, "spec": layout() }),
    )
    .await;
    let (status, named) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко",
                "defaultBoxTemplateId": boxes["id"], "defaultPalletTemplateId": pallets["id"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{named}");
    let (status, other) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    let before = host_revision(&admin.app).await;

    let (status, body) = admin.call("DELETE", &path(&boxes), None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let rev = before + 1;
    assert_eq!(host_revision(&admin.app).await, rev);
    let (status, _) = admin.call("GET", &path(&boxes), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The product that named it lost that preference at the delete's
    // revision; the other is untouched.
    let mut cleared = named.clone();
    cleared["defaultBoxTemplateId"] = Value::Null;
    cleared["rev"] = json!(rev);
    let (_, products) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(products, json!([other, cleared]));
    let mut data = cleared.clone();
    for office_only in ["id", "rev"] {
        data.as_object_mut().unwrap().remove(office_only);
    }
    assert_eq!(
        admin.feed(before).await,
        json!([
            { "entity": "label_templates", "id": boxes["id"], "rev": rev, "deleted": true },
            { "entity": "products", "id": named["id"], "rev": rev, "deleted": false, "data": data }
        ])
    );
    assert_eq!(
        audit_trail(&admin.app, "template.delete").await,
        vec![admin.row(
            "template.delete",
            "template",
            boxes["id"].as_str().unwrap(),
            json!({ "name": "Коробка 58×40", "purpose": "box", "productsCleared": 1 })
        )]
    );

    // Repeated after a lost answer, the delete changes nothing.
    let (status, _) = admin.call("DELETE", &path(&boxes), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_trail(&admin.app, "template.delete").await.len(), 1);
    let (status, body) = admin
        .call(
            "DELETE",
            "/v1/office/templates/9b2e4a6c-0000-4000-8000-000000000000",
            None,
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}

#[tokio::test]
async fn technologists_write_templates() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, created) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/templates",
            Some(box_template("Коробка 58×40")),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin.call_as(&tech, "DELETE", &path(&created), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let trail = [
        audit_trail(&admin.app, "template.create").await,
        audit_trail(&admin.app, "template.update").await,
        audit_trail(&admin.app, "template.delete").await,
    ]
    .concat();
    assert_eq!(
        trail,
        vec![
            audit_row(
                &tech_id,
                "template.create",
                "template",
                &id,
                json!({ "name": "Коробка 58×40", "purpose": "box" })
            ),
            audit_row(
                &tech_id,
                "template.update",
                "template",
                &id,
                json!({ "changed": ["enabled"], "enabled": { "from": true, "to": false } })
            ),
            audit_row(
                &tech_id,
                "template.delete",
                "template",
                &id,
                json!({ "name": "Коробка 58×40", "purpose": "box", "productsCleared": 0 })
            ),
        ]
    );
}

#[tokio::test]
async fn an_unknown_template_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/templates/9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, _) = admin.call("GET", path, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
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
            Some(json!({ "enabled": false, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
```

10. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// The free-text validators that trim their input, each with the
    /// `details.field` it names.
    fn text_validators() -> [(&'static str, TextCheck); 10] {
        [
            ("name", |text| person_name("name", text).map(drop)),
            ("name", |text| product_name("name", text).map(drop)),
            ("printName", |text| {
                print_name("printName", Some(text)).map(drop)
            }),
            ("org.name", |text| {
                company("org", text, None, GLN, &[]).map(drop)
            }),
            ("lines.0", |text| line_name("lines.0", text).map(drop)),
            ("name", |text| device_name("name", text).map(drop)),
```

заменить на

<!-- prettier-ignore -->
```rust
    /// The free-text validators that trim their input, each with the
    /// `details.field` it names.
    fn text_validators() -> [(&'static str, TextCheck); 11] {
        [
            ("name", |text| person_name("name", text).map(drop)),
            ("name", |text| product_name("name", text).map(drop)),
            ("name", |text| template_name("name", text).map(drop)),
            ("printName", |text| {
                print_name("printName", Some(text)).map(drop)
            }),
            ("org.name", |text| {
                company("org", text, None, GLN, &[]).map(drop)
            }),
            ("lines.0", |text| line_name("lines.0", text).map(drop)),
            ("name", |text| device_name("name", text).map(drop)),
```

11. Там же фрагмент

<!-- prettier-ignore -->
```rust
            field(count(
                "shelfLifeDays",
                Some(MAX_SHELF_LIFE_DAYS + 1),
                MAX_SHELF_LIFE_DAYS
            )),
            "shelfLifeDays"
        );
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
            field(count(
                "shelfLifeDays",
                Some(MAX_SHELF_LIFE_DAYS + 1),
                MAX_SHELF_LIFE_DAYS
            )),
            "shelfLifeDays"
        );
    }

    #[test]
    fn a_spec_is_an_object_of_at_most_256_kb_once_written_compactly() {
        let spec = serde_json::json!({ "widthMm": 58, "dpi": 203 });
        // Stored compactly, its keys in byte order.
        assert_eq!(
            template_spec("spec", &spec).unwrap(),
            r#"{"dpi":203,"widthMm":58}"#
        );
        let filler = |bytes: usize| serde_json::json!({ "f": "x".repeat(bytes - 8) });
        assert_eq!(
            template_spec("spec", &filler(MAX_SPEC_BYTES))
                .unwrap()
                .len(),
            MAX_SPEC_BYTES
        );
        assert_eq!(
            field(template_spec("spec", &filler(MAX_SPEC_BYTES + 1))),
            "spec"
        );
        for not_an_object in [
            serde_json::json!([]),
            serde_json::json!("{}"),
            serde_json::Value::Null,
        ] {
            assert_eq!(
                field(template_spec("spec", &not_an_object)),
                "spec",
                "{not_an_object}"
            );
        }
    }

    #[test]
    fn category_codes_are_every_category_or_a_short_list_without_repeats() {
        assert!(category_codes("codes", None).is_ok());
        assert!(category_codes("codes", Some(&[8, 15])).is_ok());
        let longest: Vec<u32> = (1..=100).collect();
        assert!(category_codes("codes", Some(&longest)).is_ok());
        let too_long: Vec<u32> = (1..=101).collect();
        for bad in [&[][..], &[8, 15, 8][..], &too_long[..]] {
            assert_eq!(
                field(category_codes("codes", Some(bad))),
                "codes",
                "{bad:?}"
            );
        }
    }
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test templates --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_host::templates` ``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: FAIL — не компилируется: ``error[E0425]: cannot find function `template_name` in this scope``, то же для `template_spec`, `category_codes` и `MAX_SPEC_BYTES`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::LabelTemplate`, `markiro_proto::LabelTemplateCreate`, `markiro_proto::LabelTemplateSummary`, `markiro_proto::LabelTemplateUpdate` ``.

- [ ] **Step 3: Правило слота, проверки, записи протокола и маршруты шаблонов**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };
```

заменить на

<!-- prettier-ignore -->
```rust
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
    pub expected_rev: i64,
}

/// A label template without its layout (`GET /v1/office/templates`), as
/// the cloud's `LabelTemplateSummaryDto`. The size, the resolution and the
/// language are read from the stored `spec` as they stand, `null` where it
/// has none of the right type: the host does not check a layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTemplateSummary {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// `null` for every category, otherwise the product-group codes.
    pub chz_product_group_codes: Option<Vec<u32>>,
    pub stock: bool,
    pub width_mm: Option<serde_json::Number>,
    pub height_mm: Option<serde_json::Number>,
    pub dpi: Option<u32>,
    pub language: Option<String>,
    pub rev: i64,
}

/// A label template with its layout (`GET /v1/office/templates/{id}`, and
/// the answer of `POST` and `PUT`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTemplate {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    pub chz_product_group_codes: Option<Vec<u32>>,
    /// From the wizard: its name, purpose and layout never change, and it is
    /// never deleted.
    pub stock: bool,
    /// The layout as the host stores it; the UI checked it with
    /// `labelTemplateSpecSchema`.
    pub spec: serde_json::Value,
    pub rev: i64,
}

/// `POST /v1/office/templates`: a template of the office's own, never a
/// stock one; a copy of a stock template is a `POST` of its layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelTemplateCreate {
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// Left out or `null`: every category.
    #[serde(default)]
    pub chz_product_group_codes: Option<Vec<u32>>,
    pub spec: serde_json::Value,
}

/// `PUT /v1/office/templates/{id}`: only the fields sent change;
/// `chzProductGroupCodes: null` widens the template to every category, and
/// leaving it out keeps its categories. A purpose never changes, so it is no
/// field here; a stock template takes only `enabled` and its categories (or
/// its own name and layout, unchanged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelTemplateUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub chz_product_group_codes: Option<Option<Vec<u32>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };
```

2. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod network;
pub mod pairing_code;
pub mod rate_limit;
pub mod routes;
pub mod secrets;
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod tls;
pub mod validate;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod network;
pub mod pairing_code;
pub mod rate_limit;
pub mod routes;
pub mod secrets;
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod templates;
pub mod tls;
pub mod validate;
```

3. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// An optional count: none, or 1 to `max`.
pub fn count(field: &str, value: Option<u32>, max: u32) -> Result<(), ApiError> {
    match value {
        Some(value) if !(1..=max).contains(&value) => {
            Err(ApiError::validation(field, format!("1-{max}, or none")))
        }
        _ => Ok(()),
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
/// An optional count: none, or 1 to `max`.
pub fn count(field: &str, value: Option<u32>, max: u32) -> Result<(), ApiError> {
    match value {
        Some(value) if !(1..=max).contains(&value) => {
            Err(ApiError::validation(field, format!("1-{max}, or none")))
        }
        _ => Ok(()),
    }
}

/// A label template's name: trimmed, 1-200 characters, as the cloud's.
pub fn template_name(field: &str, name: &str) -> Result<String, ApiError> {
    clean_text(field, name, 200, "the name").map(str::to_owned)
}

/// The largest layout the host keeps: 256 KB of compact JSON.
pub const MAX_SPEC_BYTES: usize = 256 * 1024;

/// A template's layout: a JSON object of at most [`MAX_SPEC_BYTES`] once
/// written compactly, which is how the host stores it (object keys in byte
/// order). Returns that text. Whether it is a label is the UI's check
/// (`labelTemplateSpecSchema`).
pub fn template_spec(field: &str, spec: &serde_json::Value) -> Result<String, ApiError> {
    if !spec.is_object() {
        return Err(ApiError::validation(
            field,
            "the spec must be a JSON object",
        ));
    }
    let text = serde_json::to_string(spec).map_err(ApiError::internal)?;
    if text.len() > MAX_SPEC_BYTES {
        return Err(ApiError::validation(
            field,
            format!("the spec must be at most {MAX_SPEC_BYTES} bytes"),
        ));
    }
    Ok(text)
}

/// The most codes a template lists: more than there are product groups, so
/// the bound only caps the work one request can ask for.
pub const MAX_CATEGORY_CODES: usize = 100;

/// A template's categories: `None` for every category, or a non-empty list
/// of at most [`MAX_CATEGORY_CODES`] codes without repeats. That each code is
/// a product group is checked against the table (`templates::check_groups`).
pub fn category_codes(field: &str, codes: Option<&[u32]>) -> Result<(), ApiError> {
    let Some(codes) = codes else {
        return Ok(());
    };
    if codes.is_empty() || codes.len() > MAX_CATEGORY_CODES {
        return Err(ApiError::validation(
            field,
            format!("1-{MAX_CATEGORY_CODES} product-group codes, or null for every category"),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if !codes.iter().all(|code| seen.insert(code)) {
        return Err(ApiError::validation(
            field,
            "a product-group code is repeated",
        ));
    }
    Ok(())
}
```

4. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
    pub const TEMPLATE_CREATE: &str = "template.create";
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
}
```

5. Create `apps/standalone/host/src/templates.rs`:

<!-- prettier-ignore -->
```rust
//! Label-template rules the host arbitrates (spec §2, decision 11): which
//! template may stand in a default slot, and which defaults a template
//! holds. The layout itself (`spec`) is the UI's (`labelTemplateSpecSchema`).

use markiro_proto::TemplatePurpose;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// What decides whether a template may stand in a default slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// `None` for every category.
    pub codes: Option<Vec<u32>>,
}

/// Whether a template may stand in the default slot of `purpose` for
/// `category`, where `None` is the organization's slot: an enabled template
/// of the slot's purpose that covers the category, and for the organization
/// every category. `@markiro/domain`'s `isBoxLabelTemplateEligible` and
/// `isPalletLabelTemplateEligible` answer the same for a product's group (a
/// scoped template never fits a product without one), so the organization's
/// slot is the slot of a product without a group. The cases both sides must
/// answer alike are in `proto/fixtures/template-eligibility.json`.
pub fn fits(scope: &Scope, purpose: TemplatePurpose, category: Option<u32>) -> bool {
    scope.enabled
        && scope.purpose == purpose
        && match (&scope.codes, category) {
            (None, _) => true,
            (Some(codes), Some(code)) => codes.contains(&code),
            (Some(_), None) => false,
        }
}

/// `validation_failed` on `field` unless every code is a ЧЗ product group.
/// The codes are distinct (`validate::category_codes`).
pub async fn check_groups(
    conn: &mut SqliteConnection,
    field: &str,
    codes: Option<&[u32]>,
) -> Result<(), ApiError> {
    let Some(codes) = codes else {
        return Ok(());
    };
    let found: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chz_product_groups WHERE code IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(codes).map_err(ApiError::internal)?)
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)?;
    if usize::try_from(found).is_ok_and(|found| found == codes.len()) {
        Ok(())
    } else {
        Err(ApiError::validation(field, "no such product group"))
    }
}

/// The organization's column for its default of `purpose`.
pub fn org_column(purpose: TemplatePurpose) -> &'static str {
    match purpose {
        TemplatePurpose::Box => "default_box_template_id",
        TemplatePurpose::Pallet => "default_pallet_template_id",
        TemplatePurpose::ProductDuplicate => "default_duplicate_template_id",
    }
}

/// The defaults a template holds: whether it is the organization's default
/// of its purpose, and the categories whose default it is, ascending. A slot
/// takes only a template of its own purpose, so no other slot names it.
pub struct Usage {
    pub organization: bool,
    pub categories: Vec<u32>,
}

pub async fn usage(
    conn: &mut SqliteConnection,
    id: &str,
    purpose: TemplatePurpose,
) -> Result<Usage, ApiError> {
    let organization: Option<i64> = sqlx::query_scalar(&format!(
        "SELECT 1 FROM org_profile WHERE id = 1 AND {} = ?",
        org_column(purpose)
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let categories: Vec<u32> = sqlx::query_scalar(
        "SELECT chz_group_code FROM category_template_defaults WHERE template_id = ? \
         ORDER BY chz_group_code",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Usage {
        organization: organization.is_some(),
        categories,
    })
}

/// `conflict` on `template_is_default`, as the cloud's
/// `LABEL_TEMPLATE_IS_DEFAULT`: the template is the organization's default
/// (`organizationDefault`) or the default of the categories listed
/// (`categoryDefaults`), and the change would leave that default unfit or
/// without a template.
pub fn is_default(organization: bool, categories: Vec<u32>) -> ApiError {
    ApiError::conflict(
        "template_is_default",
        "the template is a default that the change would break",
    )
    .with_details(json!({
        "constraint": "template_is_default",
        "organizationDefault": organization,
        "categoryDefaults": categories,
    }))
}
```

6. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod templates;
```

7. Create `apps/standalone/host/src/routes/templates.rs`:

<!-- prettier-ignore -->
```rust
//! Label templates (spec §4.3): `GET /v1/office/templates` (every role;
//! summaries without the layout), `GET …/{id}` (with it), `POST`, `PUT
//! …/{id}` and `DELETE …/{id}` (administrators and technologists; `PUT`
//! with `expectedRev`). The host keeps `spec` an object of at most 256 KB;
//! the UI checks the layout. A purpose never changes. A stock template, from
//! the wizard, keeps its name, purpose and layout and is never deleted
//! (`stock_template`): it may be disabled or narrowed, and copied by a
//! `POST`. A template is never disabled, narrowed out of a category it is
//! the default of, or deleted while it is a default (`template_is_default`).
//! Deleting a template clears the products' preferences that name it, each
//! product at the delete's revision, and leaves a tombstone.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    entities, LabelTemplate, LabelTemplateCreate, LabelTemplateSummary, LabelTemplateUpdate,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::feed;
use crate::server::AppState;
use crate::templates::{self, Scope};
use crate::validate;

/// The summary columns: the size, resolution and language as the stored
/// spec has them, `NULL` where it has none of the right JSON type.
const SUMMARY: &str = "SELECT id, name, purpose, enabled, category_codes, stock, rev, \
     CASE WHEN json_type(spec, '$.widthMm') IN ('integer', 'real') \
         THEN spec -> '$.widthMm' END AS width_mm, \
     CASE WHEN json_type(spec, '$.heightMm') IN ('integer', 'real') \
         THEN spec -> '$.heightMm' END AS height_mm, \
     CASE WHEN json_type(spec, '$.dpi') = 'integer' THEN json_extract(spec, '$.dpi') END AS dpi, \
     CASE WHEN json_type(spec, '$.language') = 'text' \
         THEN json_extract(spec, '$.language') END AS language \
     FROM label_templates";

const SELECT: &str =
    "SELECT id, name, purpose, enabled, category_codes, stock, spec, rev FROM label_templates";

#[derive(sqlx::FromRow)]
struct SummaryRow {
    id: String,
    name: String,
    purpose: String,
    enabled: bool,
    category_codes: Option<String>,
    stock: bool,
    rev: i64,
    width_mm: Option<String>,
    height_mm: Option<String>,
    dpi: Option<i64>,
    language: Option<String>,
}

#[derive(sqlx::FromRow)]
struct TemplateRow {
    id: String,
    name: String,
    purpose: String,
    enabled: bool,
    category_codes: Option<String>,
    stock: bool,
    spec: String,
    rev: i64,
}

fn parse_codes(text: Option<String>) -> Result<Option<Vec<u32>>, ApiError> {
    text.map(|codes| serde_json::from_str(&codes))
        .transpose()
        .map_err(ApiError::internal)
}

/// A number of the stored spec, as JSON text (`58`, `58.5`).
fn spec_number(text: Option<String>) -> Option<serde_json::Number> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

fn summary(row: SummaryRow) -> Result<LabelTemplateSummary, ApiError> {
    Ok(LabelTemplateSummary {
        id: row.id,
        name: row.name,
        purpose: row.purpose.parse().map_err(ApiError::internal)?,
        enabled: row.enabled,
        chz_product_group_codes: parse_codes(row.category_codes)?,
        stock: row.stock,
        width_mm: spec_number(row.width_mm),
        height_mm: spec_number(row.height_mm),
        dpi: row.dpi.and_then(|dpi| u32::try_from(dpi).ok()),
        language: row.language,
        rev: row.rev,
    })
}

fn template(row: TemplateRow) -> Result<LabelTemplate, ApiError> {
    Ok(LabelTemplate {
        id: row.id,
        name: row.name,
        purpose: row.purpose.parse().map_err(ApiError::internal)?,
        enabled: row.enabled,
        chz_product_group_codes: parse_codes(row.category_codes)?,
        stock: row.stock,
        spec: serde_json::from_str(&row.spec).map_err(ApiError::internal)?,
        rev: row.rev,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<LabelTemplate>, ApiError> {
    let row: Option<TemplateRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(template).transpose()
}

/// Codes as `label_templates.category_codes` stores them.
fn codes_text(codes: Option<&[u32]>) -> Result<Option<String>, ApiError> {
    codes
        .map(serde_json::to_string)
        .transpose()
        .map_err(ApiError::internal)
}

pub async fn list_templates(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<LabelTemplateSummary>>, ApiError> {
    let rows: Vec<SummaryRow> = sqlx::query_as(&format!("{SUMMARY} ORDER BY name, id"))
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(summary)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn get_template(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<LabelTemplate>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read(&mut conn, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such template"))
}

pub async fn create_template(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<LabelTemplateCreate>,
) -> Result<Json<LabelTemplate>, ApiError> {
    context.require_catalog()?;
    let name = validate::template_name("name", &create.name)?;
    let codes = create.chz_product_group_codes.as_deref();
    validate::category_codes("chzProductGroupCodes", codes)?;
    let spec = validate::template_spec("spec", &create.spec)?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    templates::check_groups(&mut tx, "chzProductGroupCodes", codes).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(create.purpose.as_str())
    .bind(create.enabled)
    .bind(codes_text(codes)?)
    .bind(&spec)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_CREATE,
            target_type: Some("template"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name, "purpose": create.purpose }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("template vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_template(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<LabelTemplateUpdate>,
) -> Result<Json<LabelTemplate>, ApiError> {
    context.require_catalog()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::template_name("name", name))
        .transpose()?;
    if let Some(codes) = &update.chz_product_group_codes {
        validate::category_codes("chzProductGroupCodes", codes.as_deref())?;
    }
    let spec = update
        .spec
        .as_ref()
        .map(|spec| validate::template_spec("spec", spec))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    if let Some(codes) = &update.chz_product_group_codes {
        templates::check_groups(&mut tx, "chzProductGroupCodes", codes.as_deref()).await?;
    }
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such template"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let name = name.unwrap_or_else(|| current.name.clone());
    let enabled = update.enabled.unwrap_or(current.enabled);
    let codes = update
        .chz_product_group_codes
        .clone()
        .unwrap_or_else(|| current.chz_product_group_codes.clone());
    let spec_changed = update
        .spec
        .as_ref()
        .is_some_and(|spec| *spec != current.spec);
    if current.stock && (name != current.name || spec_changed) {
        return Err(ApiError::conflict(
            "stock_template",
            "a stock template keeps its name and layout: copy it to change them",
        ));
    }
    if enabled != current.enabled || codes != current.chz_product_group_codes {
        // A default stays a template that fits its slot.
        let usage = templates::usage(&mut tx, &id, current.purpose).await?;
        let next = Scope {
            purpose: current.purpose,
            enabled,
            codes: codes.clone(),
        };
        let organization = usage.organization && !templates::fits(&next, current.purpose, None);
        let categories: Vec<u32> = usage
            .categories
            .into_iter()
            .filter(|code| !templates::fits(&next, current.purpose, Some(*code)))
            .collect();
        if organization || !categories.is_empty() {
            return Err(templates::is_default(organization, categories));
        }
    }
    let Some(details) = audit::update_details_hiding(
        &[
            ("name", json!(current.name), json!(name)),
            ("enabled", json!(current.enabled), json!(enabled)),
            (
                "chzProductGroupCodes",
                json!(current.chz_product_group_codes),
                json!(codes),
            ),
        ],
        // The layout is named, never logged.
        &[("spec", spec_changed)],
    ) else {
        // Nothing actually changed: report the template as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE label_templates SET name = ?, enabled = ?, category_codes = ?, \
         spec = COALESCE(?, spec), rev = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(enabled)
    .bind(codes_text(codes.as_deref())?)
    .bind(spec.filter(|_| spec_changed))
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
            action: actions::TEMPLATE_UPDATE,
            target_type: Some("template"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("template vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// `DELETE /v1/office/templates/{id}` → 204. A template deleted already (its
/// tombstone stands) answers 204 again, so a delete repeated after a lost
/// answer does not fail; one that never existed is `not_found`.
pub async fn delete_template(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    let Some(current) = read(&mut tx, &id).await? else {
        let deleted: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM tombstones WHERE entity = ? AND id = ?")
                .bind(entities::LABEL_TEMPLATES)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        return match deleted {
            Some(_) => Ok(StatusCode::NO_CONTENT),
            None => Err(ApiError::not_found("no such template")),
        };
    };
    if current.stock {
        return Err(ApiError::conflict(
            "stock_template",
            "a stock template is never deleted: disable it instead",
        ));
    }
    let usage = templates::usage(&mut tx, &id, current.purpose).await?;
    if usage.organization || !usage.categories.is_empty() {
        return Err(templates::is_default(usage.organization, usage.categories));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    // The products' preferences go first and take the revision, so a
    // station's copy of each product changes too (`ON DELETE SET NULL`
    // would change the rows behind the feed's back).
    let cleared = sqlx::query(
        "UPDATE products SET \
         default_box_template_id = CASE WHEN default_box_template_id = ?1 \
             THEN NULL ELSE default_box_template_id END, \
         default_pallet_template_id = CASE WHEN default_pallet_template_id = ?1 \
             THEN NULL ELSE default_pallet_template_id END, \
         rev = ?2 \
         WHERE default_box_template_id = ?1 OR default_pallet_template_id = ?1",
    )
    .bind(&id)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .rows_affected();
    sqlx::query("DELETE FROM label_templates WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    feed::remove(&mut tx, entities::LABEL_TEMPLATES, &id, rev)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_DELETE,
            target_type: Some("template"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "name": current.name,
                "purpose": current.purpose,
                "productsCleared": cleared,
            }),
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
            get(crate::routes::products::list_products)
                .post(crate::routes::products::create_product),
        )
        .route(
            "/v1/office/products/{id}",
            put(crate::routes::products::update_product),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
            put(crate::routes::office_users::update_user),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
            get(crate::routes::products::list_products)
                .post(crate::routes::products::create_product),
        )
        .route(
            "/v1/office/products/{id}",
            put(crate::routes::products::update_product),
        )
        .route(
            "/v1/office/templates",
            get(crate::routes::templates::list_templates)
                .post(crate::routes::templates::create_template),
        )
        .route(
            "/v1/office/templates/{id}",
            get(crate::routes::templates::get_template)
                .put(crate::routes::templates::update_template)
                .delete(crate::routes::templates::delete_template),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
            put(crate::routes::office_users::update_user),
        )
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test templates --offline`
Expected: PASS — 10 тестов (среди них сверка с `template-eligibility.json`, 12 случаев).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
Expected: PASS — 31 тест.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 5 модульных тестов и 32 теста фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
Every office change, login outcome, pairing and initialization writes one
`audit_log` row. Action names come only from `audit::actions`; a new writer
adds its name there. Every `denied` row carries `details.reason` from
`audit::reasons`. An update row carries `details.changed` (field names) and
`{ from, to }` for each changed field (`audit::update_details`), except `pinPhc`:
it is named in `changed` without a value (`audit::update_details_hiding`).
Details never hold pairing codes, keys, tokens, passwords, salts or hashes, and
a refused login never records the typed login. An attempt refused by a rate
limiter writes no row, so a flood cannot fill the log. An office write the host
refuses (`validation_failed`, `forbidden`, `not_found`, `stale_revision`,
`conflict`) changed nothing and writes no row either, as for every office
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
```

заменить на

<!-- prettier-ignore -->
```text
Every office change, login outcome, pairing and initialization writes one
`audit_log` row. Action names come only from `audit::actions`; a new writer
adds its name there. Every `denied` row carries `details.reason` from
`audit::reasons`. An update row carries `details.changed` (field names) and
`{ from, to }` for each changed field (`audit::update_details`), except `pinPhc`
and a template's `spec`: they are named in `changed` without a value
(`audit::update_details_hiding`), a hash because it is a secret and a layout
because it may be 256 KB.
Details never hold pairing codes, keys, tokens, passwords, salts or hashes, and
a refused login never records the typed login. An attempt refused by a rate
limiter writes no row, so a flood cannot fill the log. An office write the host
refuses (`validation_failed`, `forbidden`, `not_found`, `stale_revision`,
`conflict`) changed nothing and writes no row either, as for every office
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
```

2. Там же фрагмент

<!-- prettier-ignore -->
```text
names a template of the slot's purpose; whether that template is enabled
and covers the product's group is the domain's rule, which the office
applies when it offers templates and the station before it uses one, so a
template disabled or narrowed later never blocks editing or archiving the
product. (The cloud has no per-product template since its 2026-09-02 spec;
these follow the stage-1 spec.) National-catalog links, photos, EGAIS
codes, prices and default counterparties are not part of the standalone
catalog yet.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
names a template of the slot's purpose; whether that template is enabled
and covers the product's group is the domain's rule, which the office
applies when it offers templates and the station before it uses one, so a
template disabled or narrowed later never blocks editing or archiving the
product. (The cloud has no per-product template since its 2026-09-02 spec;
these follow the stage-1 spec.) National-catalog links, photos, EGAIS
codes, prices and default counterparties are not part of the standalone
catalog yet.

Label templates (`GET/POST/PUT/DELETE /v1/office/templates`): every office
role reads them — the list as summaries without the layout, whose size,
resolution and language come from the stored `spec` as they stand (`null`
where it has nothing of the right type), and `GET …/{id}` with it;
administrators and technologists write them. The host keeps `spec` a JSON
object of at most 256 KB written compactly (`validate::template_spec`), its
object keys in byte order, and never checks the layout: that is
`labelTemplateSpecSchema` in the UI. A name is 1–200 characters;
`chzProductGroupCodes` is `null` (every category) or 1–100 codes without
repeats, each a product group. A purpose never changes: `PUT` has no
`purpose` field, so one sent is `validation_failed`. `PUT` changes only what
it sends, with `expectedRev`, and `chzProductGroupCodes: null` widens a
template to every category. A stock template (the wizard's) keeps its name,
purpose and layout and is never deleted (`conflict` on `stock_template`);
it may be disabled or narrowed, and a copy is an ordinary `POST` of its
layout. The organization's default of a purpose stays an enabled template
for every category, and a category's default an enabled template covering
that category: a change that would break either, and any delete of a
default, is `conflict` on `template_is_default` with `organizationDefault`
and `categoryDefaults` (codes), as the cloud's `LABEL_TEMPLATE_IS_DEFAULT`.
The rule for a slot is `templates::fits`, the domain's
`isBoxLabelTemplateEligible` rewritten: `proto/fixtures/template-eligibility.json`
holds the cases both sides answer alike. Deleting a template clears every
product preference that names it at the delete's revision, so those
products ride the feed again, and leaves a tombstone; a delete repeated
after a lost answer finds the tombstone and answers 204 again, and an id
that never existed is `not_found`.

## Reference sync
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
  суженный позже, не мешает править и архивировать товар. Удаление шаблона
  снимает ссылки сам хост (товар получает новую ревизию и едет по ленте), а
  `ON DELETE SET NULL` остаётся страховкой. В облаке шаблона на товар нет со
  спецификации 2026-09-02; эти ссылки — решение этапа 1. Поля Нацкаталога, фото,
  ЕГАИС, цены и контрагент по умолчанию в каталог автономного продукта пока не
  входят.
- `label_templates(id, name, purpose CHECK(purpose IN ('box','pallet','product_duplicate')), enabled, category_codes JSON, spec JSON, stock, rev)`;
  `spec` хранится как текст JSON до 256 КБ, его схему проверяет интерфейс
  (`labelTemplateSpecSchema`).
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))`.
  Хост не даёт удалить или выключить шаблон, который стоит по умолчанию у
  организации или категории (`template_is_default`).
- `audit_log(id, at, actor_kind CHECK(actor_kind IN ('office_user','device','system')), actor_id, action, target_type, target_id, result, details JSON)`.
```

заменить на

<!-- prettier-ignore -->
```text
  суженный позже, не мешает править и архивировать товар. Удаление шаблона
  снимает ссылки сам хост (товар получает новую ревизию и едет по ленте), а
  `ON DELETE SET NULL` остаётся страховкой. В облаке шаблона на товар нет со
  спецификации 2026-09-02; эти ссылки — решение этапа 1. Поля Нацкаталога, фото,
  ЕГАИС, цены и контрагент по умолчанию в каталог автономного продукта пока не
  входят.
- `label_templates(id, name, purpose CHECK(purpose IN ('box','pallet','product_duplicate')), enabled, category_codes JSON, spec JSON, stock, rev)`;
  `spec` хранится как текст JSON до 256 КБ, его схему проверяет интерфейс
  (`labelTemplateSpecSchema`). Правила плана 1e1: хост держит `spec` объектом
  JSON не больше 256 КБ в компактной записи (ключи — в порядке байтов) и макет
  не проверяет; список (`GET /v1/office/templates`) отдаёт сводки без макета —
  размер, разрешение и язык читаются из сохранённого `spec` как есть, `null`, где
  значения нужного типа нет; `GET …/{id}` отдаёт шаблон целиком. Имя — 1–200
  символов, `category_codes` — `null` (все категории) или 1–100 кодов без
  повторов, каждый — товарная группа. Назначение не меняется: у `PUT` нет поля
  `purpose`. `PUT` меняет только присланное, с `expectedRev`. Типовой шаблон
  (`stock`, его создаёт мастер) не меняет имени, назначения и макета и не
  удаляется (`conflict` с `constraint: stock_template`); выключить и сузить его
  можно, а копия — обычный `POST` его макета. Удаление шаблона снимает его со
  всех товаров (ревизия удаления, товары едут по ленте) и пишет надгробие;
  повторное удаление после потерянного ответа находит надгробие и снова отвечает
  204, а неизвестный идентификатор — `not_found`.
- `category_template_defaults(chz_group_code, purpose, template_id, rev, PRIMARY KEY(chz_group_code, purpose))`.
  Хост не даёт удалить или выключить шаблон, который стоит по умолчанию у
  организации или категории (`template_is_default`). Уточнение плана 1e1:
  умолчание организации — включённый шаблон своего назначения для всех
  категорий, умолчание категории — включённый шаблон своего назначения,
  покрывающий эту категорию (`templates::fits`, правило `@markiro/domain` с общей
  фикстурой `proto/fixtures/template-eligibility.json`). Выключение, сужение,
  которое ломает одно из умолчаний, и любое удаление шаблона-умолчания —
  `conflict` с `constraint: template_is_default`, `organizationDefault` и
  `categoryDefaults` (коды), как облачный `LABEL_TEMPLATE_IS_DEFAULT`.
- `audit_log(id, at, actor_kind CHECK(actor_kind IN ('office_user','device','system')), actor_id, action, target_type, target_id, result, details JSON)`.
```

4. Там же фрагмент

<!-- prettier-ignore -->
```text
Формат: HTTP-статус и тело `{ "error": { "code": "<snake_case>", "message": "<для журнала>", "details": { … } } }`.
Интерфейс показывает текст по коду через i18n, `message` пользователю не выводится.
Коды этапа: `unauthorized` (с `details.credential` — какой признак не прошёл
проверку: `device` — приложение предлагает переподключить это устройство,
`session` — войти в офис заново, `password` — показывает текст под неверный
логин или пароль), `forbidden`, `not_found`, `method_not_allowed`, `validation_failed` (с полями
в `details`), `stale_revision`, `conflict` (с `details.constraint`: `gtin14`, `login`,
`badge`, `line_name`; у `badge` ещё `details.operatorId` — оператор, у которого этот
бейдж уже есть, когда хост нашёл владельца (иначе ключа нет): маршрут только для
администраторов, а они видят всех операторов),
`template_is_default`, `last_admin`, `sscc_below_floor`,
`pairing_code_invalid`, `pairing_code_expired`, `already_initialized`,
`loopback_only`, `protocol_unsupported`, `rate_limited`, `internal`.
```

заменить на

<!-- prettier-ignore -->
```text
Формат: HTTP-статус и тело `{ "error": { "code": "<snake_case>", "message": "<для журнала>", "details": { … } } }`.
Интерфейс показывает текст по коду через i18n, `message` пользователю не выводится.
Коды этапа: `unauthorized` (с `details.credential` — какой признак не прошёл
проверку: `device` — приложение предлагает переподключить это устройство,
`session` — войти в офис заново, `password` — показывает текст под неверный
логин или пароль), `forbidden`, `not_found`, `method_not_allowed`, `validation_failed` (с полями
в `details`), `stale_revision`, `conflict` (с `details.constraint`: `gtin14`, `login`,
`badge`, `line_name`, `stock_template`, `template_is_default`; у `badge` ещё
`details.operatorId` — оператор, у которого этот бейдж уже есть, когда хост нашёл
владельца (иначе ключа нет): маршрут только для администраторов, а они видят всех
операторов; у `template_is_default` ещё `organizationDefault` и `categoryDefaults` —
план 1e1 сделал его ограничением `conflict`, а не отдельным кодом),
`last_admin`, `sscc_below_floor`,
`pairing_code_invalid`, `pairing_code_expired`, `already_initialized`,
`loopback_only`, `protocol_unsupported`, `rate_limited`, `internal`.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/template-summary.json apps/standalone/proto/fixtures/label-template.json apps/standalone/proto/fixtures/template-create.json apps/standalone/proto/fixtures/template-update.json apps/standalone/proto/fixtures/template-eligibility.json apps/standalone/proto/fixtures/error-template-is-default.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline`
Expected: PASS — 276 тестов.

```bash
git add apps/standalone/host/src/lib.rs apps/standalone/host/src/templates.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/templates.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/templates.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/template-summary.json apps/standalone/proto/fixtures/label-template.json apps/standalone/proto/fixtures/template-create.json apps/standalone/proto/fixtures/template-update.json apps/standalone/proto/fixtures/template-eligibility.json apps/standalone/proto/fixtures/error-template-is-default.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): шаблоны этикеток на хосте — типовые шаблоны и отказ template_is_default" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Умолчания шаблонов — `GET/PUT /v1/office/template-defaults`

Умолчания читаются и пишутся одним документом: три умолчания организации и все умолчания категорий (решение 3). `PUT` заменяет документ целиком — умолчание организации, которого нет, пусто, умолчание категории, которого нет в `categories`, снимается — и несёт `expectedRev` документа. Каждое умолчание обязано подходить своему слоту (`templates::fits`, задача 4): иначе `validation_failed` с полем. Изменение умолчаний организации переписывает её запись с новой ревизией (запись едет по ленте); умолчание категории, назначенное, изменённое или снятое, едет по ленте под своим ключом, снятое — надгробием, которое повторное назначение снимает. Документ без изменений ничего не пишет.

**Files:**

- Create: `apps/standalone/host/src/routes/template_defaults.rs`, `apps/standalone/proto/fixtures/template-defaults.json`, `template-defaults-update.json`
- Modify: `apps/standalone/host/src/{templates,audit,server}.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/template_defaults.rs` (Create), `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates»), спецификация §4.3, §4.5

**Interfaces:**

- Consumes:
  - `templates::{Scope, fits, check_groups}` (задача 4), `feed::{remove, restore}`, `category_default_id`, `CategoryTemplateDefault`, `entities::CATEGORY_TEMPLATE_DEFAULTS` (задача 2);
  - `OfficeContext::{require_catalog, require_catalog_in}`; `audit::update_details`;
  - `admin`, `Admin::{call, call_as, row, feed, technologist, technologist_session}`, `audit_row`, `audit_trail`, `audit_rows`, `host_revision`, `tombstones` — `host/tests/support/app.rs`.
- Produces:
  - `pub async fn templates::scope(conn, id) -> Result<Option<Scope>, ApiError>`, `pub async fn templates::check_slot(conn, field, id, purpose, category: Option<u32>) -> Result<(), ApiError>`;
  - `actions::TEMPLATE_DEFAULTS_UPDATE`;
  - `TemplateDefaults`, `CategoryTemplateDefaultInput`, `TemplateDefaultsUpdate` — `proto/src/lib.rs`;
  - `routes::template_defaults::{get_template_defaults, put_template_defaults}`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/template-defaults-update.json`:

<!-- prettier-ignore -->
```json
{
  "defaultBoxTemplateId": "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  "defaultPalletTemplateId": null,
  "defaultDuplicateTemplateId": null,
  "categories": [
    {
      "chzProductGroupCode": 8,
      "purpose": "box",
      "templateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d"
    }
  ],
  "expectedRev": 63
}
```

2. Create `apps/standalone/proto/fixtures/template-defaults.json`:

<!-- prettier-ignore -->
```json
{
  "defaultBoxTemplateId": "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  "defaultPalletTemplateId": null,
  "defaultDuplicateTemplateId": null,
  "categories": [
    {
      "chzProductGroupCode": 8,
      "purpose": "box",
      "templateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d"
    }
  ],
  "rev": 64
}
```

3. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LabelTemplate,
    LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary, LabelTemplateUpdate,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate,
    OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord,
    OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode,
    PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup, ProductRecord,
    ProductStatus, ProductUpdate, SiteRecord, SsccCounterUpdate, SsccState, TemplatePurpose,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LabelTemplate,
    LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary, LabelTemplateUpdate,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate,
    OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord,
    OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode,
    PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup, ProductRecord,
    ProductStatus, ProductUpdate, SiteRecord, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

4. Там же фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn template_defaults_fixtures_round_trip_as_one_document() {
    let document: TemplateDefaults = round_trip("template-defaults.json");
    let update: TemplateDefaultsUpdate = round_trip("template-defaults-update.json");
    assert_eq!(update.categories.len(), document.categories.len());
    let entry = &update.categories[0];
    assert_eq!(
        (
            entry.chz_product_group_code,
            entry.purpose,
            &entry.template_id
        ),
        (
            document.categories[0].chz_product_group_code,
            document.categories[0].purpose,
            &document.categories[0].template_id
        )
    );
    // A slot is the category and the purpose; nothing else is sent.
    let mut value = fixture("template-defaults-update.json");
    value["categories"][0]["rev"] = Value::from(64);
    assert!(serde_json::from_value::<TemplateDefaultsUpdate>(value).is_err());
    // The organization's defaults left out are none; the categories are
    // always the whole list.
    let bare: TemplateDefaultsUpdate =
        serde_json::from_value(serde_json::json!({ "categories": [], "expectedRev": 1 })).unwrap();
    assert_eq!(bare.default_box_template_id, None);
    assert!(serde_json::from_value::<TemplateDefaultsUpdate>(
        serde_json::json!({ "expectedRev": 1 })
    )
    .is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

5. Create `apps/standalone/host/tests/template_defaults.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, audit_row, audit_rows, audit_trail, host_revision, tombstones, Admin};

const DEFAULTS: &str = "/v1/office/template-defaults";

/// A template through the office; returns its id.
async fn template(admin: &Admin, purpose: &str, enabled: bool, codes: Value) -> String {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": format!("Шаблон {purpose}"), "purpose": purpose, "enabled": enabled,
                "chzProductGroupCodes": codes, "spec": { "widthMm": 58, "heightMm": 40 }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

/// The templates the tests choose among.
struct Templates {
    universal: String,
    milk: String,
    pallet: String,
    disabled: String,
}

async fn templates(admin: &Admin) -> Templates {
    Templates {
        universal: template(admin, "box", true, Value::Null).await,
        milk: template(admin, "box", true, json!([8])).await,
        pallet: template(admin, "pallet", true, Value::Null).await,
        disabled: template(admin, "box", false, Value::Null).await,
    }
}

fn slot(code: u32, purpose: &str, template_id: &str) -> Value {
    json!({ "chzProductGroupCode": code, "purpose": purpose, "templateId": template_id })
}

async fn document(admin: &Admin) -> Value {
    let (status, document) = admin.call("GET", DEFAULTS, None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    document
}

async fn put(admin: &Admin, body: Value) -> (StatusCode, Value) {
    admin.call("PUT", DEFAULTS, Some(body)).await
}

#[tokio::test]
async fn the_defaults_are_one_document_and_stations_get_them() {
    let admin = admin().await;
    let t = templates(&admin).await;
    // The organization's record is the only part yet: the wizard wrote it.
    assert_eq!(
        document(&admin).await,
        json!({
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": null, "categories": [], "rev": 1
        })
    );
    let before = host_revision(&admin.app).await;

    let (status, set) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
            "categories": [slot(15, "box", &t.universal), slot(8, "box", &t.milk), slot(8, "pallet", &t.pallet)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let rev = before + 1;
    // Categories come back by code, then purpose.
    let categories = json!([
        slot(8, "box", &t.milk),
        slot(8, "pallet", &t.pallet),
        slot(15, "box", &t.universal)
    ]);
    assert_eq!(
        set,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
            "defaultDuplicateTemplateId": null, "categories": categories, "rev": rev
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![admin.row(
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({
                "changed": ["defaultBoxTemplateId", "defaultPalletTemplateId", "categories"],
                "defaultBoxTemplateId": { "from": null, "to": t.universal },
                "defaultPalletTemplateId": { "from": null, "to": t.pallet },
                "categories": { "from": [], "to": categories }
            })
        )]
    );
    // Every role reads the document.
    let tech = admin.technologist().await;
    let (status, read) = admin.call_as(&tech, "GET", DEFAULTS, None).await;
    assert_eq!((status, read), (StatusCode::OK, set));
    // Stations get each category default under its slot, and the
    // organization's defaults in its record.
    let item = |id: &str, data: Value| json!({ "entity": "category_template_defaults", "id": id, "rev": rev, "deleted": false, "data": data });
    assert_eq!(
        admin.feed(before).await,
        json!([
            item("15:box", slot(15, "box", &t.universal)),
            item("8:box", slot(8, "box", &t.milk)),
            item("8:pallet", slot(8, "pallet", &t.pallet)),
            {
                "entity": "org_profile", "id": "1", "rev": rev, "deleted": false,
                "data": {
                    "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010",
                    "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow",
                    "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
                    "defaultDuplicateTemplateId": null
                }
            }
        ])
    );
}

#[tokio::test]
async fn a_cleared_category_default_leaves_a_tombstone_that_setting_it_again_drops() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({ "categories": [slot(8, "box", &t.milk)], "expectedRev": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let set_rev = set["rev"].as_i64().unwrap();

    let (status, cleared) = put(&admin, json!({ "categories": [], "expectedRev": set_rev })).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    let cleared_rev = cleared["rev"].as_i64().unwrap();
    assert_eq!(cleared_rev, set_rev + 1);
    // Only the tombstone: the organization's record did not change.
    assert_eq!(
        admin.feed(set_rev).await,
        json!([{ "entity": "category_template_defaults", "id": "8:box", "rev": cleared_rev, "deleted": true }])
    );
    assert_eq!(
        tombstones(&admin.app).await,
        vec![(
            "category_template_defaults".to_owned(),
            "8:box".to_owned(),
            cleared_rev
        )]
    );

    let (status, again) = put(
        &admin,
        json!({ "categories": [slot(8, "box", &t.universal)], "expectedRev": cleared_rev }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let again_rev = again["rev"].as_i64().unwrap();
    assert!(tombstones(&admin.app).await.is_empty());
    assert_eq!(
        admin.feed(cleared_rev).await,
        json!([{
            "entity": "category_template_defaults", "id": "8:box", "rev": again_rev, "deleted": false,
            "data": slot(8, "box", &t.universal)
        }])
    );
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update")
            .await
            .len(),
        3
    );
}

#[tokio::test]
async fn every_default_must_fit_its_slot() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let unknown = "9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (body, field) in [
        // Another purpose, scoped (the organization's default covers every
        // category), disabled, unknown.
        (
            json!({ "defaultBoxTemplateId": t.pallet }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultBoxTemplateId": t.milk }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultBoxTemplateId": t.disabled }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultDuplicateTemplateId": t.universal }),
            "defaultDuplicateTemplateId",
        ),
        (
            json!({ "defaultPalletTemplateId": unknown }),
            "defaultPalletTemplateId",
        ),
        // A category default must cover its category.
        (
            json!({ "categories": [slot(15, "box", &t.milk)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(8, "pallet", &t.universal)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(18, "box", &t.universal)] }),
            "categories.0.chzProductGroupCode",
        ),
        (
            json!({ "categories": [slot(8, "box", &t.universal), slot(8, "box", &t.milk)] }),
            "categories.1",
        ),
    ] {
        let mut body = body;
        if body.get("categories").is_none() {
            body["categories"] = json!([]);
        }
        body["expectedRev"] = json!(1);
        let (status, refused) = put(&admin, body.clone()).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{body}"
        );
    }
    for body in [
        json!({ "categories": [{ "chzProductGroupCode": 8, "purpose": "label", "templateId": t.universal }], "expectedRev": 1 }),
        json!({ "categories": [], "expectedRev": 1, "defaultLabelTemplateId": t.universal }),
    ] {
        let (status, refused) = put(&admin, body).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed"))
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_older_document_is_refused_and_an_unchanged_one_writes_nothing() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let body = |pallet: Option<&str>, expected_rev: i64| {
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": pallet,
            "categories": [], "expectedRev": expected_rev
        })
    };
    let (status, set) = put(&admin, body(None, 1)).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let rev = set["rev"].as_i64().unwrap();
    let (status, refused) = put(&admin, body(Some(&t.pallet), 1)).await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(rev))
    );
    let (status, same) = put(&admin, body(None, rev)).await;
    assert_eq!((status, same), (StatusCode::OK, set));
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update")
            .await
            .len(),
        1
    );

    // A change of the organization's record moves the document too.
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, renamed) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": "ООО «Атолл-Юг»", "inn": org["inn"], "gln": org["gln"],
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(document(&admin).await["rev"], renamed["rev"]);
    let (status, refused) = put(&admin, body(Some(&t.pallet), rev)).await;
    assert_eq!(
        (status, refused["error"]["details"]["currentRev"].clone()),
        (StatusCode::CONFLICT, renamed["rev"].clone())
    );
}

#[tokio::test]
async fn a_default_set_here_keeps_its_template_from_being_disabled() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, _) = put(
        &admin,
        json!({ "defaultBoxTemplateId": t.universal, "categories": [], "expectedRev": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", t.universal),
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("template_is_default"))
    );
}

#[tokio::test]
async fn technologists_set_the_defaults() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, set) = admin
        .call_as(
            &tech,
            "PUT",
            DEFAULTS,
            Some(json!({ "categories": [slot(8, "box", &t.milk)], "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![audit_row(
            &tech_id,
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({
                "changed": ["categories"],
                "categories": { "from": [], "to": [slot(8, "box", &t.milk)] }
            })
        )]
    );
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test template_defaults --offline`
Expected: FAIL — 6 тестов из 6: маршрута нет, и хост отвечает `404` там, где тесты ждут `200` и `400`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::TemplateDefaults`, `markiro_proto::TemplateDefaultsUpdate` ``.

- [ ] **Step 3: Документ умолчаний — записи протокола, проверка слота и маршрут**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub chz_product_group_codes: Option<Option<Vec<u32>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };
```

заменить на

<!-- prettier-ignore -->
```rust
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub chz_product_group_codes: Option<Option<Vec<u32>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    pub expected_rev: i64,
}

/// The templates' defaults as one document (`GET
/// /v1/office/template-defaults`, and the answer of its `PUT`): the
/// organization's default of each purpose and every category default, by
/// code then purpose. `rev` is the document's revision: the newest of the
/// organization's record, a category default and a cleared category
/// default's tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDefaults {
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub default_duplicate_template_id: Option<String>,
    pub categories: Vec<CategoryTemplateDefault>,
    pub rev: i64,
}

/// A category default in `PUT /v1/office/template-defaults`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryTemplateDefaultInput {
    pub chz_product_group_code: u32,
    pub purpose: TemplatePurpose,
    pub template_id: String,
}

/// `PUT /v1/office/template-defaults`: the whole document over its `rev`.
/// An organization default left out or `null` is none, and a category
/// default left out of `categories` is cleared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateDefaultsUpdate {
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    #[serde(default)]
    pub default_duplicate_template_id: Option<String>,
    pub categories: Vec<CategoryTemplateDefaultInput>,
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };
```

2. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
    pub const TEMPLATE_CREATE: &str = "template.create";
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
    pub const TEMPLATE_CREATE: &str = "template.create";
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
}
```

3. В `apps/standalone/host/src/templates.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub fn fits(scope: &Scope, purpose: TemplatePurpose, category: Option<u32>) -> bool {
    scope.enabled
        && scope.purpose == purpose
        && match (&scope.codes, category) {
            (None, _) => true,
            (Some(codes), Some(code)) => codes.contains(&code),
            (Some(_), None) => false,
        }
}
```

заменить на

<!-- prettier-ignore -->
```rust
pub fn fits(scope: &Scope, purpose: TemplatePurpose, category: Option<u32>) -> bool {
    scope.enabled
        && scope.purpose == purpose
        && match (&scope.codes, category) {
            (None, _) => true,
            (Some(codes), Some(code)) => codes.contains(&code),
            (Some(_), None) => false,
        }
}

/// A template's scope, or `None` when there is no such template.
pub async fn scope(conn: &mut SqliteConnection, id: &str) -> Result<Option<Scope>, ApiError> {
    let row: Option<(String, bool, Option<String>)> =
        sqlx::query_as("SELECT purpose, enabled, category_codes FROM label_templates WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    row.map(|(purpose, enabled, codes)| {
        Ok(Scope {
            purpose: purpose.parse().map_err(ApiError::internal)?,
            enabled,
            codes: codes
                .map(|codes| serde_json::from_str(&codes))
                .transpose()
                .map_err(ApiError::internal)?,
        })
    })
    .transpose()
}

/// `validation_failed` on `field` unless `id` names a template that fits the
/// default slot of `purpose` for `category` (`None`: the organization's).
pub async fn check_slot(
    conn: &mut SqliteConnection,
    field: &str,
    id: &str,
    purpose: TemplatePurpose,
    category: Option<u32>,
) -> Result<(), ApiError> {
    match scope(conn, id).await? {
        Some(scope) if fits(&scope, purpose, category) => Ok(()),
        Some(_) => Err(ApiError::validation(
            field,
            "the template does not fit this default: another purpose, disabled, or not covering the category",
        )),
        None => Err(ApiError::validation(field, "no such template")),
    }
}
```

4. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod templates;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod template_defaults;
pub mod templates;
```

5. Create `apps/standalone/host/src/routes/template_defaults.rs`:

<!-- prettier-ignore -->
```rust
//! The templates' defaults (spec §4.3) as one document: the organization's
//! default of each purpose and every category's. `GET
//! /v1/office/template-defaults` (every role) and `PUT` (administrators and
//! technologists) with the document's `expectedRev`: the newest revision of
//! the organization's record, a category default and a cleared category
//! default's tombstone. Every default must fit its slot (`templates::fits`).
//! The organization's defaults ride its feed record; a category default
//! rides the feed as `<code>:<purpose>`, and clearing one writes its
//! tombstone.

use std::collections::{BTreeMap, HashSet};

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    category_default_id, entities, CategoryTemplateDefault, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::feed;
use crate::server::AppState;
use crate::templates;

/// The document's revision. It moves with every change of the defaults, and
/// with any change of the organization's record too, which a write over an
/// older revision then has to read again.
const DOCUMENT_REV: &str = "SELECT MAX(rev) FROM (\
     SELECT rev FROM org_profile WHERE id = 1 \
     UNION ALL SELECT rev FROM category_template_defaults \
     UNION ALL SELECT rev FROM tombstones WHERE entity = 'category_template_defaults')";

/// The document; `not_found` before the wizard created the organization.
async fn read(conn: &mut SqliteConnection) -> Result<TemplateDefaults, ApiError> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT default_box_template_id, default_pallet_template_id, \
         default_duplicate_template_id FROM org_profile WHERE id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let (default_box_template_id, default_pallet_template_id, default_duplicate_template_id) =
        row.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    let rows: Vec<(u32, String, String)> = sqlx::query_as(
        "SELECT chz_group_code, purpose, template_id FROM category_template_defaults \
         ORDER BY chz_group_code, purpose",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let categories = rows
        .into_iter()
        .map(|(code, purpose, template_id)| {
            Ok(CategoryTemplateDefault {
                chz_product_group_code: code,
                purpose: purpose.parse().map_err(ApiError::internal)?,
                template_id,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let rev: i64 = sqlx::query_scalar(DOCUMENT_REV)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(TemplateDefaults {
        default_box_template_id,
        default_pallet_template_id,
        default_duplicate_template_id,
        categories,
        rev,
    })
}

pub async fn get_template_defaults(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<TemplateDefaults>, ApiError> {
    // One read transaction: the parts and the revision from one snapshot.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let document = read(&mut tx).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(document))
}

pub async fn put_template_defaults(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<TemplateDefaultsUpdate>,
) -> Result<Json<TemplateDefaults>, ApiError> {
    context.require_catalog()?;
    let mut slots = HashSet::new();
    for (index, entry) in update.categories.iter().enumerate() {
        if !slots.insert((entry.chz_product_group_code, entry.purpose)) {
            return Err(ApiError::validation(
                &format!("categories.{index}"),
                "this category's default of this purpose is given twice",
            ));
        }
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    for (field, id, purpose) in [
        (
            "defaultBoxTemplateId",
            &update.default_box_template_id,
            TemplatePurpose::Box,
        ),
        (
            "defaultPalletTemplateId",
            &update.default_pallet_template_id,
            TemplatePurpose::Pallet,
        ),
        (
            "defaultDuplicateTemplateId",
            &update.default_duplicate_template_id,
            TemplatePurpose::ProductDuplicate,
        ),
    ] {
        if let Some(id) = id {
            templates::check_slot(&mut tx, field, id, purpose, None).await?;
        }
    }
    for (index, entry) in update.categories.iter().enumerate() {
        let code = entry.chz_product_group_code;
        templates::check_groups(
            &mut tx,
            &format!("categories.{index}.chzProductGroupCode"),
            Some(&[code]),
        )
        .await?;
        templates::check_slot(
            &mut tx,
            &format!("categories.{index}.templateId"),
            &entry.template_id,
            entry.purpose,
            Some(code),
        )
        .await?;
    }
    let current = read(&mut tx).await?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let mut categories: Vec<CategoryTemplateDefault> = update
        .categories
        .iter()
        .map(|entry| CategoryTemplateDefault {
            chz_product_group_code: entry.chz_product_group_code,
            purpose: entry.purpose,
            template_id: entry.template_id.clone(),
        })
        .collect();
    categories.sort_by_key(|entry| (entry.chz_product_group_code, entry.purpose));
    let Some(details) = audit::update_details(&[
        (
            "defaultBoxTemplateId",
            json!(current.default_box_template_id),
            json!(update.default_box_template_id),
        ),
        (
            "defaultPalletTemplateId",
            json!(current.default_pallet_template_id),
            json!(update.default_pallet_template_id),
        ),
        (
            "defaultDuplicateTemplateId",
            json!(current.default_duplicate_template_id),
            json!(update.default_duplicate_template_id),
        ),
        ("categories", json!(current.categories), json!(categories)),
    ]) else {
        // Nothing actually changed: report the document as-is without
        // bumping the revision, writing a row nobody changed, or auditing a
        // no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let organization = (
        &update.default_box_template_id,
        &update.default_pallet_template_id,
        &update.default_duplicate_template_id,
    );
    if organization
        != (
            &current.default_box_template_id,
            &current.default_pallet_template_id,
            &current.default_duplicate_template_id,
        )
    {
        sqlx::query(
            "UPDATE org_profile SET default_box_template_id = ?, \
             default_pallet_template_id = ?, default_duplicate_template_id = ?, rev = ? \
             WHERE id = 1",
        )
        .bind(organization.0)
        .bind(organization.1)
        .bind(organization.2)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    let was: BTreeMap<(u32, TemplatePurpose), String> = current
        .categories
        .into_iter()
        .map(|entry| {
            (
                (entry.chz_product_group_code, entry.purpose),
                entry.template_id,
            )
        })
        .collect();
    let now: BTreeMap<(u32, TemplatePurpose), String> = categories
        .into_iter()
        .map(|entry| {
            (
                (entry.chz_product_group_code, entry.purpose),
                entry.template_id,
            )
        })
        .collect();
    for &(code, purpose) in was.keys().filter(|slot| !now.contains_key(slot)) {
        sqlx::query(
            "DELETE FROM category_template_defaults WHERE chz_group_code = ? AND purpose = ?",
        )
        .bind(code)
        .bind(purpose.as_str())
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        feed::remove(
            &mut tx,
            entities::CATEGORY_TEMPLATE_DEFAULTS,
            &category_default_id(code, purpose),
            rev,
        )
        .await
        .map_err(ApiError::internal)?;
    }
    for (&(code, purpose), template_id) in &now {
        match was.get(&(code, purpose)) {
            Some(old) if old == template_id => {}
            Some(_) => {
                sqlx::query(
                    "UPDATE category_template_defaults SET template_id = ?, rev = ? \
                     WHERE chz_group_code = ? AND purpose = ?",
                )
                .bind(template_id)
                .bind(rev)
                .bind(code)
                .bind(purpose.as_str())
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            }
            None => {
                sqlx::query(
                    "INSERT INTO category_template_defaults \
                     (chz_group_code, purpose, template_id, rev) VALUES (?, ?, ?, ?)",
                )
                .bind(code)
                .bind(purpose.as_str())
                .bind(template_id)
                .bind(rev)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
                feed::restore(
                    &mut tx,
                    entities::CATEGORY_TEMPLATE_DEFAULTS,
                    &category_default_id(code, purpose),
                )
                .await
                .map_err(ApiError::internal)?;
            }
        }
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_DEFAULTS_UPDATE,
            target_type: Some("template_defaults"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

6. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/templates/{id}",
            get(crate::routes::templates::get_template)
                .put(crate::routes::templates::update_template)
                .delete(crate::routes::templates::delete_template),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
            put(crate::routes::office_users::update_user),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/templates/{id}",
            get(crate::routes::templates::get_template)
                .put(crate::routes::templates::update_template)
                .delete(crate::routes::templates::delete_template),
        )
        .route(
            "/v1/office/template-defaults",
            get(crate::routes::template_defaults::get_template_defaults)
                .put(crate::routes::template_defaults::put_template_defaults),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
            put(crate::routes::office_users::update_user),
        )
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test template_defaults --offline`
Expected: PASS — 6 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 5 модульных тестов и 33 теста фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
and `categoryDefaults` (codes), as the cloud's `LABEL_TEMPLATE_IS_DEFAULT`.
The rule for a slot is `templates::fits`, the domain's
`isBoxLabelTemplateEligible` rewritten: `proto/fixtures/template-eligibility.json`
holds the cases both sides answer alike. Deleting a template clears every
product preference that names it at the delete's revision, so those
products ride the feed again, and leaves a tombstone; a delete repeated
after a lost answer finds the tombstone and answers 204 again, and an id
that never existed is `not_found`.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
and `categoryDefaults` (codes), as the cloud's `LABEL_TEMPLATE_IS_DEFAULT`.
The rule for a slot is `templates::fits`, the domain's
`isBoxLabelTemplateEligible` rewritten: `proto/fixtures/template-eligibility.json`
holds the cases both sides answer alike. Deleting a template clears every
product preference that names it at the delete's revision, so those
products ride the feed again, and leaves a tombstone; a delete repeated
after a lost answer finds the tombstone and answers 204 again, and an id
that never existed is `not_found`.

The defaults are one document (`GET/PUT /v1/office/template-defaults`): the
organization's default of each purpose (`defaultBoxTemplateId`,
`defaultPalletTemplateId`, `defaultDuplicateTemplateId`) and every
category's (`categories`, by code then purpose). Every role reads it;
administrators and technologists replace it whole, so an organization
default left out is none and a category default left out of `categories` is
cleared. Its `rev` is the newest revision of the organization's record, a
category default and a cleared category default's tombstone: any change of
the defaults, and any change of the organization's record, through
`PUT /v1/office/org` too, makes a write over an older `rev`
`stale_revision`. Every default must fit its slot (`templates::fits`):
`validation_failed` on `defaultBoxTemplateId` and its siblings, on
`categories.{i}.templateId`, on `categories.{i}.chzProductGroupCode` for an
unknown group, and on `categories.{i}` for a slot given twice. A change of
the organization's defaults rewrites its record at the new revision, so it
rides the feed; a category default set, changed or cleared rides the feed
under its `<code>:<purpose>` key, a cleared one as a tombstone that setting
it again drops. An unchanged document writes nothing, and the audit row
(`template_defaults.update`, target `template_defaults`/`1`) carries the
changed parts with `{ from, to }`, `categories` as whole lists.

## Reference sync
```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
  организации или категории (`template_is_default`). Уточнение плана 1e1:
  умолчание организации — включённый шаблон своего назначения для всех
  категорий, умолчание категории — включённый шаблон своего назначения,
  покрывающий эту категорию (`templates::fits`, правило `@markiro/domain` с общей
  фикстурой `proto/fixtures/template-eligibility.json`). Выключение, сужение,
  которое ломает одно из умолчаний, и любое удаление шаблона-умолчания —
  `conflict` с `constraint: template_is_default`, `organizationDefault` и
  `categoryDefaults` (коды), как облачный `LABEL_TEMPLATE_IS_DEFAULT`.
- `audit_log(id, at, actor_kind CHECK(actor_kind IN ('office_user','device','system')), actor_id, action, target_type, target_id, result, details JSON)`.
```

заменить на

<!-- prettier-ignore -->
```text
  организации или категории (`template_is_default`). Уточнение плана 1e1:
  умолчание организации — включённый шаблон своего назначения для всех
  категорий, умолчание категории — включённый шаблон своего назначения,
  покрывающий эту категорию (`templates::fits`, правило `@markiro/domain` с общей
  фикстурой `proto/fixtures/template-eligibility.json`). Выключение, сужение,
  которое ломает одно из умолчаний, и любое удаление шаблона-умолчания —
  `conflict` с `constraint: template_is_default`, `organizationDefault` и
  `categoryDefaults` (коды), как облачный `LABEL_TEMPLATE_IS_DEFAULT`.
  Умолчания читаются и пишутся одним документом
  (`GET/PUT /v1/office/template-defaults`): три умолчания организации и все
  умолчания категорий; `PUT` заменяет документ целиком (не присланное умолчание
  организации — пусто, не присланное умолчание категории снимается) и несёт
  `expectedRev` документа — самую новую ревизию из записи организации, умолчаний
  категорий и надгробий снятых умолчаний, поэтому и правка профиля организации
  делает старую запись устаревшей. Неподходящий слоту шаблон — `validation_failed`
  с полем (`defaultBoxTemplateId`, `categories.{i}.templateId`, …).
- `audit_log(id, at, actor_kind CHECK(actor_kind IN ('office_user','device','system')), actor_id, action, target_type, target_id, result, details JSON)`.
```

3. Там же фрагмент

<!-- prettier-ignore -->
```text
| `GET /v1/office/sscc`, `PUT /v1/office/sscc/counters/{prefix}/{extension}`, `PUT /v1/office/sscc/block-sizes` | чтение — все, запись — администратор            | Счётчики и размеры блоков                                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/PUT /v1/office/counterparties…`                                                                     | чтение — все, запись — администратор            | Контрагенты (архивирование вместо удаления)                                                                                                                                                                                                                                                                                                                                              |
| `GET/POST/PUT /v1/office/operators…`, `POST/DELETE /v1/office/operators/{id}/badges…`                         | администратор                                   | Операторы, PIN, бейджи; `GET /v1/office/badge-salt` — соль для расчёта хеша                                                                                                                                                                                                                                                                                                              |
| `GET/POST/PUT /v1/office/users…`                                                                              | администратор                                   | Офисные пользователи, смена пароля                                                                                                                                                                                                                                                                                                                                                       |
| `GET/POST/PUT /v1/office/lines…`                                                                              | чтение — все, запись — администратор            | Линии                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /v1/office/devices`, `PUT …/{id}` (имя, линия), `POST …/{id}/revoke`, `POST /v1/office/pairing-codes`    | администратор                                   | Устройства и коды подключения                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/office/product-groups`                                                                               | все                                             | Справочник товарных групп                                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/PUT /v1/office/products…`                                                                           | чтение — все, запись — администратор и технолог | Каталог (архивирование вместо удаления)                                                                                                                                                                                                                                                                                                                                                  |
| `GET/POST/PUT/DELETE /v1/office/templates…`, `PUT /v1/office/template-defaults`                               | чтение — все, запись — администратор и технолог | Шаблоны и умолчания                                                                                                                                                                                                                                                                                                                                                                      |

Офисные маршруты требуют и ключ устройства, и токен сессии этого же устройства
(заголовок `X-Office-Session`).
```

заменить на

<!-- prettier-ignore -->
```text
| `GET /v1/office/sscc`, `PUT /v1/office/sscc/counters/{prefix}/{extension}`, `PUT /v1/office/sscc/block-sizes` | чтение — все, запись — администратор            | Счётчики и размеры блоков                                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/PUT /v1/office/counterparties…`                                                                     | чтение — все, запись — администратор            | Контрагенты (архивирование вместо удаления)                                                                                                                                                                                                                                                                                                                                              |
| `GET/POST/PUT /v1/office/operators…`, `POST/DELETE /v1/office/operators/{id}/badges…`                         | администратор                                   | Операторы, PIN, бейджи; `GET /v1/office/badge-salt` — соль для расчёта хеша                                                                                                                                                                                                                                                                                                              |
| `GET/POST/PUT /v1/office/users…`                                                                              | администратор                                   | Офисные пользователи, смена пароля                                                                                                                                                                                                                                                                                                                                                       |
| `GET/POST/PUT /v1/office/lines…`                                                                              | чтение — все, запись — администратор            | Линии                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /v1/office/devices`, `PUT …/{id}` (имя, линия), `POST …/{id}/revoke`, `POST /v1/office/pairing-codes`    | администратор                                   | Устройства и коды подключения                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/office/product-groups`                                                                               | все                                             | Справочник товарных групп                                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/PUT /v1/office/products…`                                                                           | чтение — все, запись — администратор и технолог | Каталог (архивирование вместо удаления)                                                                                                                                                                                                                                                                                                                                                  |
| `GET/POST/PUT/DELETE /v1/office/templates…`, `GET/PUT /v1/office/template-defaults`                           | чтение — все, запись — администратор и технолог | Шаблоны и умолчания (умолчания — один документ с `expectedRev`)                                                                                                                                                                                                                                                                                                                          |

Офисные маршруты требуют и ключ устройства, и токен сессии этого же устройства
(заголовок `X-Office-Session`).
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/template-defaults.json apps/standalone/proto/fixtures/template-defaults-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`
Expected: без предупреждений.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline`
Expected: PASS — 283 теста.

```bash
git add apps/standalone/host/src/templates.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/template_defaults.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/template_defaults.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/template-defaults.json apps/standalone/proto/fixtures/template-defaults-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): умолчания шаблонов одним документом — GET/PUT /v1/office/template-defaults" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Мастер с типовыми шаблонами — `POST /v1/bootstrap`; журнал процесса без макетов; сверка документов

Мастер принимает необязательный список `templates` (решение 10) и пишет типовые шаблоны в своей единственной транзакции, раньше профиля организации: её умолчания на них ссылаются. Флаг `orgDefault` назначает шаблон умолчанием организации своего назначения. Строка журнала `host.bootstrap` считает шаблоны (`templateCount`); прежний тест мастера ждёт `templateCount: 0`.

Тест журнала процесса проводит через хост типовой макет (мастер), офисный макет и его замену, товар с шаблоном, умолчания, отказанное удаление и ленту, и проверяет, что ни один макет не попал в журнал: макет не секрет, но бывает до 256 КБ. Падает он сначала из-за мастера — тот отвергает `templates`, — поэтому стоит в этой задаче. Здесь же — сверка документов: список фикстур плана в §4.5, действия каталога в §4.9, журнал процесса в §4.10, разбивка строки 1e в §8 и правило «Logs» в `AGENTS.md`.

**Files:**

- Create: `apps/standalone/proto/fixtures/bootstrap-request-templates.json`
- Modify: `apps/standalone/host/src/routes/bootstrap.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/bootstrap.rs`, `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates», «Logs»), спецификация §4.5, §4.9, §4.10, §8

**Interfaces:**

- Consumes:
  - `validate::{template_name, template_spec}` (задача 4), `TemplatePurpose` (задача 2);
  - `bootstrap_body`, `pair_device`, `request`, `json`, `empty`, `with_device`, `with_session`, `TestApp` — `host/tests/support/app.rs`; `pinned_client` — `host/tests/support/mod.rs`.
- Produces:
  - `BootstrapRequest.templates: Vec<StockTemplate>`, `pub struct StockTemplate { name, purpose, spec, org_default: bool }` — `proto/src/lib.rs`;
  - `pub const routes::bootstrap::MAX_STOCK_TEMPLATES: usize = 32`;
  - фикстура `proto/fixtures/bootstrap-request-templates.json`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/proto/fixtures/bootstrap-request-templates.json`:

<!-- prettier-ignore -->
```json
{
  "admin": { "login": "admin", "name": "Ирина Смирнова", "password": "correct horse battery" },
  "org": {
    "name": "ООО «Атолл»",
    "inn": "7701234567",
    "gln": "4600682000010",
    "gs1Prefixes": ["4600682"],
    "timeZone": "Europe/Moscow"
  },
  "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
  "lines": ["Линия 1"],
  "templates": [
    {
      "name": "Коробка 58×40",
      "purpose": "box",
      "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] },
      "orgDefault": true
    },
    {
      "name": "Паллета 100×150",
      "purpose": "pallet",
      "spec": { "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": [] },
      "orgDefault": true
    },
    {
      "name": "Дубликат Data Matrix 58×40 [Полное наименование]",
      "purpose": "product_duplicate",
      "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
    }
  ]
}
```

2. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

заменить на

<!-- prettier-ignore -->
```rust
#[test]
fn a_wizard_with_stock_templates_round_trips_and_an_older_one_still_reads() {
    let request: BootstrapRequest = round_trip("bootstrap-request-templates.json");
    assert_eq!(request.templates.len(), 3);
    let defaults: Vec<TemplatePurpose> = request
        .templates
        .iter()
        .filter(|template| template.org_default)
        .map(|template| template.purpose)
        .collect();
    assert_eq!(
        defaults,
        vec![TemplatePurpose::Box, TemplatePurpose::Pallet]
    );
    // A wizard from before plan 1e3 sends no templates.
    let older: BootstrapRequest = round_trip("bootstrap-request.json");
    assert!(older.templates.is_empty());
    // A stock template is enabled for every category: neither is a field.
    for field in ["enabled", "chzProductGroupCodes"] {
        let mut value = fixture("bootstrap-request-templates.json");
        value["templates"][0][field] = Value::Null;
        assert!(
            serde_json::from_value::<BootstrapRequest>(value).is_err(),
            "{field}"
        );
    }
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
```

3. В `apps/standalone/host/tests/bootstrap.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({
            "adminLogin": "admin",
            "orgName": "ООО «Атолл»",
            "issuerPrefix": "460068200",
            "lineCount": 2,
            "boxNextSerial": 1500,
            "palletNextSerial": 40
        })
    );
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({
            "adminLogin": "admin",
            "orgName": "ООО «Атолл»",
            "issuerPrefix": "460068200",
            "lineCount": 2,
            "boxNextSerial": 1500,
            "palletNextSerial": 40,
            "templateCount": 0
        })
    );
```

4. Там же фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(global_after, global_before);
    let audit_count_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'org.update'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(audit_count_after, audit_count_before);
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(global_after, global_before);
    let audit_count_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'org.update'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(audit_count_after, audit_count_before);
}

/// A layout of the given width, as the domain's stock builders make one.
fn stock_spec(width: u32) -> Value {
    json!({ "widthMm": width, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] })
}

#[tokio::test]
async fn the_wizard_keeps_the_stock_templates_and_the_organizations_defaults() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let mut body = bootstrap_body();
    body["templates"] = json!([
        { "name": " Коробка 58×40 ", "purpose": "box", "spec": stock_spec(58), "orgDefault": true },
        { "name": "Коробка 100×150", "purpose": "box", "spec": stock_spec(100) },
        { "name": "Паллета 100×150", "purpose": "pallet", "spec": stock_spec(100), "orgDefault": true },
        { "name": "Дубликат 58×40", "purpose": "product_duplicate", "spec": stock_spec(58) }
    ]);
    let (status, response) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            body,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{response}");

    // Every template is a stock one, enabled for every category, at the
    // wizard's revision.
    let stored: Vec<(String, String, String, bool, Option<String>, bool, i64)> = sqlx::query_as(
        "SELECT id, name, purpose, enabled, category_codes, stock, rev FROM label_templates ORDER BY name",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    let id_of = |name: &str| {
        stored
            .iter()
            .find(|row| row.1 == name)
            .map(|row| row.0.clone())
            .unwrap_or_else(|| panic!("no template {name}"))
    };
    assert_eq!(
        stored
            .iter()
            .map(|(_, name, purpose, enabled, codes, stock, rev)| {
                (
                    name.as_str(),
                    purpose.as_str(),
                    *enabled,
                    codes.clone(),
                    *stock,
                    *rev,
                )
            })
            .collect::<Vec<_>>(),
        vec![
            ("Дубликат 58×40", "product_duplicate", true, None, true, 1),
            ("Коробка 100×150", "box", true, None, true, 1),
            ("Коробка 58×40", "box", true, None, true, 1),
            ("Паллета 100×150", "pallet", true, None, true, 1),
        ]
    );
    // The flagged ones are the organization's defaults; no duplicate default
    // was asked for.
    let token = response["session"]["token"].as_str().unwrap();
    let (status, defaults) = app
        .send(empty(with_session(
            request("GET", "/v1/office/template-defaults"),
            &key,
            token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{defaults}");
    assert_eq!(
        defaults,
        json!({
            "defaultBoxTemplateId": id_of("Коробка 58×40"),
            "defaultPalletTemplateId": id_of("Паллета 100×150"),
            "defaultDuplicateTemplateId": null,
            "categories": [],
            "rev": 1
        })
    );
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.bootstrap'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap()["templateCount"],
        4
    );
    // Stations get the templates with the wizard's revision, layouts included.
    let (_, feed) = app
        .send(empty(with_device(
            request("GET", "/v1/changes?since=0"),
            &key,
        )))
        .await;
    let templates: Vec<&Value> = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "label_templates")
        .collect();
    assert_eq!(templates.len(), 4);
    assert!(templates
        .iter()
        .all(|item| item["rev"] == 1 && item["data"]["stock"] == true));
    assert!(templates
        .iter()
        .any(|item| item["data"]["spec"] == stock_spec(100)));
}

#[tokio::test]
async fn stock_templates_are_checked_and_a_refused_wizard_creates_nothing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let template = |purpose: &str, org_default: bool| json!({ "name": "Коробка 58×40", "purpose": purpose, "spec": stock_spec(58), "orgDefault": org_default });
    let too_many: Vec<Value> = (0..33).map(|_| template("box", false)).collect();
    let mut blank = template("box", false);
    blank["name"] = json!(" ");
    let mut not_an_object = template("box", false);
    not_an_object["spec"] = json!([]);
    for (templates, field) in [
        (json!(too_many), "templates"),
        (json!([blank]), "templates.0.name"),
        (json!([not_an_object]), "templates.0.spec"),
        (
            json!([
                template("box", true),
                template("pallet", true),
                template("box", true)
            ]),
            "templates.2.orgDefault",
        ),
    ] {
        let mut body = bootstrap_body();
        body["templates"] = templates;
        let (status, response) = app
            .send(json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                body,
            ))
            .await;
        assert_eq!(
            (status, response["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    let mut enabled = template("box", false);
    enabled["enabled"] = json!(true);
    for templates in [json!([template("label", false)]), json!([enabled])] {
        let mut body = bootstrap_body();
        body["templates"] = templates;
        let (status, response) = app
            .send(json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                body,
            ))
            .await;
        assert_eq!(
            (status, response["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed"))
        );
    }
    let (_, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(hello["initialized"], false);
    let templates: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM label_templates")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(templates, 0);
}
```

5. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. Its own binary, because it installs the global
//! tracing subscriber.

mod support;
```

заменить на

<!-- prettier-ignore -->
```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too. Its own binary, because it
//! installs the global tracing subscriber.

mod support;
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_PHC: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

#[tokio::test]
async fn secrets_never_reach_the_process_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let guard = markiro_host::logging::init(&paths.logs_dir(), false).unwrap();
    let options = StartOptions {
```

заменить на

<!-- prettier-ignore -->
```rust
/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_PHC: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// A layout whose only text is `marker`, so the log can be searched for it.
fn layout(marker: &str) -> serde_json::Value {
    json!({
        "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl",
        "elements": [{ "kind": "text", "id": "t", "xMm": 2, "yMm": 2, "text": marker, "fontSizePt": 8 }]
    })
}

#[tokio::test]
async fn secrets_never_reach_the_process_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let guard = markiro_host::logging::init(&paths.logs_dir(), false).unwrap();
    let options = StartOptions {
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let session: serde_json::Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = session["session"]["token"].as_str().unwrap().to_owned();
```

заменить на

<!-- prettier-ignore -->
```rust
    let session: serde_json::Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"],
            "templates": [{
                "name": "Коробка 58×40", "purpose": "box",
                "spec": layout("layout-marker-stock"), "orgDefault": true
            }]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = session["session"]["token"].as_str().unwrap().to_owned();
```

8. Там же фрагмент

<!-- prettier-ignore -->
```rust
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 204);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
    let wrong_device = client
        .get(format!("{base}/v1/office/me"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(wrong_device_key)
        .send()
```

заменить на

<!-- prettier-ignore -->
```rust
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 204);

    // The catalog: a template of the office's own and a new layout for it, a
    // product that prefers it, the defaults that name it, a refused delete
    // and the feed that carries every layout: none may reach the log.
    let office_template: serde_json::Value = client
        .post(format!("{base}/v1/office/templates"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "name": "Молоко 58×40", "purpose": "box", "enabled": true,
            "spec": layout("layout-marker-office-1")
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let template_id = office_template["id"].as_str().unwrap().to_owned();
    let relaid = client
        .put(format!("{base}/v1/office/templates/{template_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "spec": layout("layout-marker-office-2"), "expectedRev": office_template["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(relaid.status(), 200);
    let product = client
        .post(format!("{base}/v1/office/products"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "gtin14": "04600682000013", "name": "Молоко", "defaultBoxTemplateId": template_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(product.status(), 200);
    let defaults: serde_json::Value = client
        .get(format!("{base}/v1/office/template-defaults"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let defaults_set = client
        .put(format!("{base}/v1/office/template-defaults"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "defaultBoxTemplateId": template_id, "categories": [], "expectedRev": defaults["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(defaults_set.status(), 200);
    let refused_delete = client
        .delete(format!("{base}/v1/office/templates/{template_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(refused_delete.status(), 409);
    let catalog_feed = client
        .get(format!("{base}/v1/changes?since=0"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(catalog_feed.status(), 200);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
    let wrong_device = client
        .get(format!("{base}/v1/office/me"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(wrong_device_key)
        .send()
```

9. Там же фрагмент

<!-- prettier-ignore -->
```rust
        "pbkdf2$".to_owned(),
    ];
    secrets.extend(hashes);
    secrets.extend(device_key_hashes);
    secrets.extend(pairing_code_hashes);
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        "pbkdf2$".to_owned(),
    ];
    secrets.extend(hashes);
    secrets.extend(device_key_hashes);
    secrets.extend(pairing_code_hashes);
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
    for layout in [
        "layout-marker-stock",
        "layout-marker-office-1",
        "layout-marker-office-2",
    ] {
        assert!(!log.contains(layout), "the process log contains {layout}");
    }
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test bootstrap --offline`
Expected: FAIL — 3 теста из 9: `the_wizard_initializes_the_host_and_signs_the_admin_in` не находит `templateCount` в строке журнала, два новых получают `400` (`templates` — незнакомое поле).

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline`
Expected: FAIL — мастер с шаблонами отвергнут, токена сессии нет: `called Option::unwrap() on a None value`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: FAIL — не компилируется: ``error[E0609]: no field `templates` on type `BootstrapRequest` ``.

- [ ] **Step 3: Типовые шаблоны в мастере**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub admin: NewOfficeUser,
    pub org: OrgProfileInput,
    pub sscc: SsccStart,
    /// Names of the first production lines (1-20).
    pub lines: Vec<String>,
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub admin: NewOfficeUser,
    pub org: OrgProfileInput,
    pub sscc: SsccStart,
    /// Names of the first production lines (1-20).
    pub lines: Vec<String>,
    /// The stock label templates the app built with `@markiro/domain` (plan
    /// 1e3); a wizard from before then sends none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<StockTemplate>,
}

/// A stock label template of the wizard: enabled, for every category, and
/// kept as it came (`stock`). `orgDefault` makes it the organization's
/// default of its purpose, so the request names no id it does not have yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockTemplate {
    pub name: String,
    pub purpose: TemplatePurpose,
    pub spec: serde_json::Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub org_default: bool,
}
```

2. В `apps/standalone/host/src/routes/bootstrap.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! The first-run wizard: `POST /v1/bootstrap` (loopback, paired device, host
//! not initialized). One transaction creates the administrator, the badge
//! salt, the organization, the SSCC counters and the first lines and signs
//! the admin in. Stock label templates join in plan 1e.

use std::net::SocketAddr;
```

заменить на

<!-- prettier-ignore -->
```rust
//! The first-run wizard: `POST /v1/bootstrap` (loopback, paired device, host
//! not initialized). One transaction creates the administrator, the badge
//! salt, the stock label templates the app built with `@markiro/domain`, the
//! organization with its defaults among them, the SSCC counters and the
//! first lines, and signs the admin in; a refusal creates nothing. The
//! templates are optional: a wizard from before plan 1e3 sends none.

use std::collections::BTreeMap;
use std::net::SocketAddr;
```

3. Там же фрагмент

<!-- prettier-ignore -->
```rust
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    codes, BootstrapRequest, BootstrapResponse, OfficeRole, OfficeSession, OfficeUser,
};
use serde_json::json;
```

заменить на

<!-- prettier-ignore -->
```rust
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    codes, BootstrapRequest, BootstrapResponse, OfficeRole, OfficeSession, OfficeUser,
    TemplatePurpose,
};
use serde_json::json;
```

4. Там же фрагмент

<!-- prettier-ignore -->
```rust
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{open_session, require_loopback, AuthDevice};
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::secrets::hash_password_blocking;
use crate::server::AppState;
use crate::validate;

pub async fn bootstrap(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    device: AuthDevice,
    ApiJson(request): ApiJson<BootstrapRequest>,
) -> Result<Json<BootstrapResponse>, ApiError> {
    require_loopback(peer)?;
```

заменить на

<!-- prettier-ignore -->
```rust
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{open_session, require_loopback, AuthDevice};
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::secrets::hash_password_blocking;
use crate::server::AppState;
use crate::validate;

/// The most stock templates a wizard sends: the domain builds 20 today, and
/// the bound leaves room to grow without letting a request ask for any
/// amount.
pub const MAX_STOCK_TEMPLATES: usize = 32;

pub async fn bootstrap(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    device: AuthDevice,
    ApiJson(request): ApiJson<BootstrapRequest>,
) -> Result<Json<BootstrapResponse>, ApiError> {
    require_loopback(peer)?;
```

5. Там же фрагмент

<!-- prettier-ignore -->
```rust
    let mut lines: Vec<(String, String)> = Vec::with_capacity(request.lines.len());
    for (index, line) in request.lines.iter().enumerate() {
        let field = format!("lines.{index}");
        let (line_name, name_key) = validate::line_name(&field, line)?;
        if lines.iter().any(|(_, known)| *known == name_key) {
            return Err(ApiError::validation(&field, "line names must be unique"));
        }
        lines.push((line_name, name_key));
    }
```

заменить на

<!-- prettier-ignore -->
```rust
    let mut lines: Vec<(String, String)> = Vec::with_capacity(request.lines.len());
    for (index, line) in request.lines.iter().enumerate() {
        let field = format!("lines.{index}");
        let (line_name, name_key) = validate::line_name(&field, line)?;
        if lines.iter().any(|(_, known)| *known == name_key) {
            return Err(ApiError::validation(&field, "line names must be unique"));
        }
        lines.push((line_name, name_key));
    }
    if request.templates.len() > MAX_STOCK_TEMPLATES {
        return Err(ApiError::validation(
            "templates",
            format!("at most {MAX_STOCK_TEMPLATES} stock templates"),
        ));
    }
    let mut templates: Vec<(String, TemplatePurpose, String)> =
        Vec::with_capacity(request.templates.len());
    // The index of the organization's default of each purpose.
    let mut defaults: BTreeMap<TemplatePurpose, usize> = BTreeMap::new();
    for (index, template) in request.templates.iter().enumerate() {
        let name = validate::template_name(&format!("templates.{index}.name"), &template.name)?;
        let spec = validate::template_spec(&format!("templates.{index}.spec"), &template.spec)?;
        if template.org_default && defaults.insert(template.purpose, index).is_some() {
            return Err(ApiError::validation(
                &format!("templates.{index}.orgDefault"),
                "one organization default per purpose",
            ));
        }
        templates.push((name, template.purpose, spec));
    }
```

6. Там же фрагмент

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ? WHERE id = 1")
        .bind(badge_salt.as_slice())
        .bind(&at)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

    sqlx::query(
        "INSERT INTO org_profile (id, name, inn, gln, gs1_prefixes, time_zone, rev) VALUES (1, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&org.name)
    .bind(&org.inn)
    .bind(&org.gln)
    .bind(serde_json::to_string(&org.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(&org.time_zone)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ? WHERE id = 1")
        .bind(badge_salt.as_slice())
        .bind(&at)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

    // The templates first: the organization's defaults refer to them.
    let mut template_ids: Vec<String> = Vec::with_capacity(templates.len());
    for (name, purpose, spec) in &templates {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, ?, 1, NULL, ?, 1, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(purpose.as_str())
        .bind(spec)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        template_ids.push(id);
    }
    let default_of = |purpose: TemplatePurpose| {
        defaults
            .get(&purpose)
            .and_then(|&index| template_ids.get(index).cloned())
    };
    sqlx::query(
        "INSERT INTO org_profile (id, name, inn, gln, gs1_prefixes, time_zone, \
         default_box_template_id, default_pallet_template_id, default_duplicate_template_id, rev) \
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&org.name)
    .bind(&org.inn)
    .bind(&org.gln)
    .bind(serde_json::to_string(&org.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(&org.time_zone)
    .bind(default_of(TemplatePurpose::Box))
    .bind(default_of(TemplatePurpose::Pallet))
    .bind(default_of(TemplatePurpose::ProductDuplicate))
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
```

7. Там же фрагмент

<!-- prettier-ignore -->
```rust
            outcome: Outcome::Ok,
            details: json!({
                "adminLogin": login,
                "orgName": org.name,
                "issuerPrefix": prefix,
                "lineCount": lines.len(),
                "boxNextSerial": request.sscc.box_next_serial,
                "palletNextSerial": request.sscc.pallet_next_serial,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
            outcome: Outcome::Ok,
            details: json!({
                "adminLogin": login,
                "orgName": org.name,
                "issuerPrefix": prefix,
                "lineCount": lines.len(),
                "boxNextSerial": request.sscc.box_next_serial,
                "palletNextSerial": request.sscc.pallet_next_serial,
                "templateCount": templates.len(),
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test bootstrap --offline`
Expected: PASS — 9 тестов.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline`
Expected: PASS — 1 тест.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`
Expected: PASS — 5 модульных тестов и 34 теста фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`categories.{i}.templateId`, on `categories.{i}.chzProductGroupCode` for an
unknown group, and on `categories.{i}` for a slot given twice. A change of
the organization's defaults rewrites its record at the new revision, so it
rides the feed; a category default set, changed or cleared rides the feed
under its `<code>:<purpose>` key, a cleared one as a tombstone that setting
it again drops. An unchanged document writes nothing, and the audit row
(`template_defaults.update`, target `template_defaults`/`1`) carries the
changed parts with `{ from, to }`, `categories` as whole lists.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
`categories.{i}.templateId`, on `categories.{i}.chzProductGroupCode` for an
unknown group, and on `categories.{i}` for a slot given twice. A change of
the organization's defaults rewrites its record at the new revision, so it
rides the feed; a category default set, changed or cleared rides the feed
under its `<code>:<purpose>` key, a cleared one as a tombstone that setting
it again drops. An unchanged document writes nothing, and the audit row
(`template_defaults.update`, target `template_defaults`/`1`) carries the
changed parts with `{ from, to }`, `categories` as whole lists.

The wizard (`POST /v1/bootstrap`) takes the stock templates the app builds
with `@markiro/domain` (plan 1e3) as an optional `templates` list, so a
wizard from before then still works: at most 32 (`MAX_STOCK_TEMPLATES`; the
domain builds 20), each a name, a purpose and a layout checked as any
template's, stored enabled, for every category and `stock`, in the
wizard's one transaction, so a refusal creates nothing. `orgDefault: true`
on one template of a purpose makes it the organization's default of that
purpose, so the request names no id it does not have yet; a second of the
same purpose is `validation_failed` on `templates.{i}.orgDefault`. The
`host.bootstrap` row counts them (`templateCount`).

## Reference sync
```

2. Там же фрагмент

<!-- prettier-ignore -->
```text
Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one; plan 1f will handle them), any hash or the TLS private
key.

## Verification
```

заменить на

<!-- prettier-ignore -->
```text
Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one; plan 1f will handle them), any hash or the TLS private
key. A label template's layout is no secret, but at up to 256 KB it stays
out of the log as it stays out of audit details; `no_secrets_in_logs.rs`
walks a stock and an office layout through the template routes, the
defaults and the feed.

## Verification
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
| Метод и путь                                                                                                  | Доступ                                          | Назначение                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/hello`                                                                                               | любой                                           | `{ product: "markiro-host", protocol, minProtocol, hostId, version, time, initialized }`                                                                                                                                                                                                                                                                                                 |
| `POST /v1/local-pair`                                                                                         | только loopback                                 | Подключение устройства на том же ПК: `{ kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                      |
| `POST /v1/bootstrap`                                                                                          | устройство, loopback, хост не инициализирован   | Мастер первого запуска: администратор, организация, счётчики SSCC, линии, типовые шаблоны → `{ session }`                                                                                                                                                                                                                                                                                |
| `POST /v1/pairing/claim`                                                                                      | любой, ограничение частоты                      | `{ code, kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                                                     |
| `GET /v1/device`                                                                                              | устройство                                      | Сведения об устройстве и его линии                                                                                                                                                                                                                                                                                                                                                       |
| `PUT /v1/device/line`                                                                                         | устройство (станция)                            | Выбор линии после подключения                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/changes?since=<rev>&limit=<n>`                                                                       | устройство                                      | `{ hostId, rev, hasMore, items: [{ entity, id, rev, deleted, data }] }`, по умолчанию 500 записей (не больше 1000) и не больше 1 МиБ JSON записей; порция не разрывает ревизию; без новых записей `rev` — текущая ревизия хоста                                                                                                                                                          |
| `GET /v1/changes/stream`                                                                                      | устройство                                      | SSE: первым событием — текущая ревизия хоста; затем событие `rev` с `{ rev }` после каждого коммита, поднявшего ревизию (события строго возрастают, всплеск коммитов схлопывается в одно; событие значит «запросите ленту начиная со своей последней ревизии», а не «случился коммит»); комментарий-пульс каждые 15 с; поток заканчивается при остановке хоста или при отзыве устройства |
| `POST /v1/office/login`                                                                                       | устройство                                      | `{ login, password }` → `{ token, user, expiresAt }`                                                                                                                                                                                                                                                                                                                                     |
| `POST /v1/office/logout`, `GET /v1/office/me`                                                                 | офисная сессия                                  | Выход, текущий пользователь                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /v1/office/me/password`                                                                                  | офисная сессия, ограничение частоты             | Смена своего пароля: `{ currentPassword, newPassword }`; остальные сессии пользователя закрываются, текущая остаётся                                                                                                                                                                                                                                                                     |
```

заменить на

<!-- prettier-ignore -->
```text
| Метод и путь                                                                                                  | Доступ                                          | Назначение                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/hello`                                                                                               | любой                                           | `{ product: "markiro-host", protocol, minProtocol, hostId, version, time, initialized }`                                                                                                                                                                                                                                                                                                 |
| `POST /v1/local-pair`                                                                                         | только loopback                                 | Подключение устройства на том же ПК: `{ kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                      |
| `POST /v1/bootstrap`                                                                                          | устройство, loopback, хост не инициализирован   | Мастер первого запуска: администратор, организация, счётчики SSCC, линии, типовые шаблоны (необязательный `templates`, `orgDefault` назначает умолчание организации) → `{ session }`                                                                                                                                                                                                     |
| `POST /v1/pairing/claim`                                                                                      | любой, ограничение частоты                      | `{ code, kind, name, appVersion, capabilities }` → `{ deviceId, deviceKey, hostId }`                                                                                                                                                                                                                                                                                                     |
| `GET /v1/device`                                                                                              | устройство                                      | Сведения об устройстве и его линии                                                                                                                                                                                                                                                                                                                                                       |
| `PUT /v1/device/line`                                                                                         | устройство (станция)                            | Выбор линии после подключения                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/changes?since=<rev>&limit=<n>`                                                                       | устройство                                      | `{ hostId, rev, hasMore, items: [{ entity, id, rev, deleted, data }] }`, по умолчанию 500 записей (не больше 1000) и не больше 1 МиБ JSON записей; порция не разрывает ревизию; без новых записей `rev` — текущая ревизия хоста                                                                                                                                                          |
| `GET /v1/changes/stream`                                                                                      | устройство                                      | SSE: первым событием — текущая ревизия хоста; затем событие `rev` с `{ rev }` после каждого коммита, поднявшего ревизию (события строго возрастают, всплеск коммитов схлопывается в одно; событие значит «запросите ленту начиная со своей последней ревизии», а не «случился коммит»); комментарий-пульс каждые 15 с; поток заканчивается при остановке хоста или при отзыве устройства |
| `POST /v1/office/login`                                                                                       | устройство                                      | `{ login, password }` → `{ token, user, expiresAt }`                                                                                                                                                                                                                                                                                                                                     |
| `POST /v1/office/logout`, `GET /v1/office/me`                                                                 | офисная сессия                                  | Выход, текущий пользователь                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /v1/office/me/password`                                                                                  | офисная сессия, ограничение частоты             | Смена своего пароля: `{ currentPassword, newPassword }`; остальные сессии пользователя закрываются, текущая остаётся                                                                                                                                                                                                                                                                     |
```

4. Там же фрагмент

<!-- prettier-ignore -->
```text
- устройства — `device-update.json` (`PUT` меняет только присланные `name` и
  `lineId`; `lineId: null` снимает линию; повтор текущей линии станции — «оставить»,
  даже если линию уже архивировали); смена линии берёт одну ревизию хоста без записи
  в ленте, и потоки просыпаются (станция принимает такую линию — §5.1;
  взаимодействие с идущей сменой — план 2a); ответ `PUT` и отзыва —
  `device-record.json`;
- коды подключения — `pairing-code.json` (ответ с `id` и `createdAt`),
  `pairing-code-request.json` (необязательное тело `{ replaces }`).

### 4.6. Ошибки
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
  `pairing-code-request.json` (необязательное тело `{ replaces }`).

Формы плана 1e1 (схемы Zod к ним — план 1e2):

- товарные группы — `product-group.json` (элемент ответа
  `GET /v1/office/product-groups`, список по коду);
- товары — `office-product.json` (ответ, в списке и архивные, `status`
  вычисляется), `product-create.json`, `product-update.json` (`PUT` — запись
  целиком с `archived` и `expectedRev`);
- шаблоны — `template-summary.json` (элемент списка без макета),
  `label-template.json` (шаблон с макетом), `template-create.json`,
  `template-update.json` (`PUT` меняет только присланное; `null` в
  `chzProductGroupCodes` — все категории; поля `purpose` нет),
  `error-template-is-default.json` (отказ с `organizationDefault` и
  `categoryDefaults`);
- умолчания — `template-defaults.json` (документ с `rev`),
  `template-defaults-update.json` (документ целиком с `expectedRev`);
- лента каталога — `changes-catalog.json` (`products`, `label_templates`,
  `category_template_defaults` с ключом `<код>:<назначение>`, умолчания
  организации в её записи, надгробия);
- мастер — `bootstrap-request-templates.json` (типовые шаблоны с `orgDefault`);
- правило слота — `template-eligibility.json`: случаи, на которые `templates::fits`
  хоста и правило `@markiro/domain` отвечают одинаково.

### 4.6. Ошибки
```

5. Там же фрагмент

<!-- prettier-ignore -->
```text
Отказанная запись офиса (ошибка проверки, нет прав, нет записи, `stale_revision`,
`conflict`) ничего не изменила и строки не пишет — так пишут все писатели офиса с
плана 1b1, план 1d2 записал это правилом. Строки с результатом `denied` — отказы
входа, смены своего пароля и подключения по коду.

### 4.10. Ограничение частоты и журналы процесса
```

заменить на

<!-- prettier-ignore -->
```text
Отказанная запись офиса (ошибка проверки, нет прав, нет записи, `stale_revision`,
`conflict`) ничего не изменила и строки не пишет — так пишут все писатели офиса с
плана 1b1, план 1d2 записал это правилом. Строки с результатом `denied` — отказы
входа, смены своего пароля и подключения по коду.

Каталог (план 1e1) пишет `product.create` (`{ gtin14, name }`), `product.update`,
`template.create` (`{ name, purpose }`), `template.update`, `template.delete`
(`{ name, purpose, productsCleared }`) и `template_defaults.update` (цель
`template_defaults`/`1`, `categories` — списки целиком); строки изменений — как
везде, `changed` и `{ from, to }`, но изменённый `spec` шаблона назван в
`changed` без значений: макет бывает до 256 КБ. Мастер считает типовые шаблоны в
строке `host.bootstrap` (`templateCount`).

### 4.10. Ограничение частоты и журналы процесса
```

6. Там же фрагмент

<!-- prettier-ignore -->
```text
- `POST /v1/pairing/claim` и `POST /v1/office/login`: не больше 10 попыток в минуту
  с одного адреса, дальше `rate_limited`.
- Журнал процесса (`tracing` в `logs/`, ежедневная ротация, 14 файлов) не содержит
  ключей, токенов, кодов подключения, паролей, PIN и хешей. Это проверяет тест.

## 5. Приложение
```

заменить на

<!-- prettier-ignore -->
```text
- `POST /v1/pairing/claim` и `POST /v1/office/login`: не больше 10 попыток в минуту
  с одного адреса, дальше `rate_limited`.
- Журнал процесса (`tracing` в `logs/`, ежедневная ротация, 14 файлов) не содержит
  ключей, токенов, кодов подключения, паролей, PIN и хешей. Это проверяет тест.
  Макетов шаблонов в нём тоже нет (план 1e1): это не секрет, но макет бывает до
  256 КБ; тот же тест проводит типовой и офисный макеты через маршруты шаблонов,
  умолчаний и ленты.

## 5. Приложение
```

7. Там же фрагмент

<!-- prettier-ignore -->
```text
| План | Содержание                                                                                                                                                                                                                        | Результат                                                                     | Зависит от |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------- |
| 1a   | Каркас: пакет и Cargo-воркспейс, `apps/standalone/AGENTS.md`, хост (конфигурация, база и миграции, сертификат, HTTPS, `hello`, точка входа службы, журналы процесса), оболочка приложения с экраном «хост не найден», CI и ESLint | Хост отвечает на `hello` по HTTPS, приложение запускается, задания CI зелёные | —          |
| 1b   | Подключение местной станции, мастер первого запуска, офисные пользователи, вход в офис и роли, организация и SSCC, журнал действий                                                                                                | На одном ПК проходит первый запуск и вход в офис                              | 1a         |
| 1c   | Коды подключения и `claim`, выбор линии, лента изменений и SSE, локальная база станции, синхронизация справочников, строка состояния связи                                                                                        | Второе устройство подключается и получает справочники                         | 1b         |
| 1d   | Экраны контрагентов, линий, операторов с PIN и бейджами, устройств                                                                                                                                                                | Справочники людей и устройств ведутся из офиса и доходят до станций           | 1c         |
| 1e   | Товарные группы, каталог, шаблоны (импорт, форма, предпросмотр, умолчания), типовые шаблоны в мастере                                                                                                                             | Каталог и шаблоны ведутся из офиса и доходят до станций                       | 1c         |
| 1f   | Вход оператора по PIN и бейджу, блокировка, киоск-режим, заглушка цеха                                                                                                                                                            | Сценарий раздела 1 целиком                                                    | 1d         |
```

заменить на

<!-- prettier-ignore -->
```text
| План | Содержание                                                                                                                                                                                                                        | Результат                                                                     | Зависит от |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------- |
| 1a   | Каркас: пакет и Cargo-воркспейс, `apps/standalone/AGENTS.md`, хост (конфигурация, база и миграции, сертификат, HTTPS, `hello`, точка входа службы, журналы процесса), оболочка приложения с экраном «хост не найден», CI и ESLint | Хост отвечает на `hello` по HTTPS, приложение запускается, задания CI зелёные | —          |
| 1b   | Подключение местной станции, мастер первого запуска, офисные пользователи, вход в офис и роли, организация и SSCC, журнал действий                                                                                                | На одном ПК проходит первый запуск и вход в офис                              | 1a         |
| 1c   | Коды подключения и `claim`, выбор линии, лента изменений и SSE, локальная база станции, синхронизация справочников, строка состояния связи                                                                                        | Второе устройство подключается и получает справочники                         | 1b         |
| 1d   | Экраны контрагентов, линий, операторов с PIN и бейджами, устройств                                                                                                                                                                | Справочники людей и устройств ведутся из офиса и доходят до станций           | 1c         |
| 1e   | Товарные группы, каталог, шаблоны (импорт, форма, предпросмотр, умолчания), типовые шаблоны в мастере; планы 1e1 (хост), 1e2 (каталог в офисе и копии станции), 1e3 (экраны шаблонов и мастер)                                    | Каталог и шаблоны ведутся из офиса и доходят до станций                       | 1c         |
| 1f   | Вход оператора по PIN и бейджу, блокировка, киоск-режим, заглушка цеха                                                                                                                                                            | Сценарий раздела 1 целиком                                                    | 1d         |
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/bootstrap-request-templates.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Run (`apps/standalone/dist` собран): `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: без предупреждений.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
Expected: PASS — 40 наборов, 392 теста (хост 247, `proto` 39, оболочка 106; до плана 36 наборов и 348 тестов), без предупреждений компилятора.

```bash
git add apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/tests/bootstrap.rs apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/bootstrap-request-templates.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): типовые шаблоны в мастере, журнал процесса без макетов, сверка документов каталога" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] Вне песочницы: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — 40 наборов, 392 теста (было 36 и 348), без предупреждений компилятора; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` — без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым JSON и MD — чисто; `git diff --check <начало плана>..HEAD` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — без изменений зелёный: вебвью не менялось, а Vitest читает только прежние фикстуры, и они не менялись.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `apps/station`, `packages/*`, `apps/standalone/src`, `apps/standalone/test`, `apps/standalone/src-tauri`, миграции `0001`–`0007`, существующие фикстуры, манифесты и lockfile не менялись.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - новыми маршрутами пока никто не пользуется: экраны каталога, копии на станции и мастер с типовыми шаблонами — планы 1e2 и 1e3; настоящие макеты домена (20 типовых шаблонов) через хост не проводились — тесты шлют маленькие объекты;
  - лента с каталогом на станции, которая каталог ещё не держит: по правилам `reference-sync` незнакомые сущности пропускаются — проверить вручную на двух ПК после плана 1e2;
  - задание CI `standalone-windows-build` — для него нужен push.

---

## Перенесено

- План 1e2 (приложение: слой протокола, экраны каталога, копии на станции):
  - схемы Zod и проверки Vitest для фикстур плана: `product-group.json`, `office-product.json`, `product-create.json`, `product-update.json`, `template-summary.json`, `label-template.json`, `template-create.json`, `template-update.json`, `error-template-is-default.json`, `template-defaults.json`, `template-defaults-update.json`, `changes-catalog.json`, `bootstrap-request-templates.json`; сборщики тел в `requests.ts`, методы `HostApi`, поддельные ответы; схема записи организации — с тремя `default…TemplateId`;
  - сверка правила слота: Vitest читает `proto/fixtures/template-eligibility.json` и проверяет `isBoxLabelTemplateEligible` и `isPalletLabelTemplateEligible` (слот организации — категория `null`); у домена нет пары для дубликата — правило вебвью или дополнение домена (последнее трогает `packages/domain` и потребителей `apps/station`) — решает план 1e2;
  - копии станции `ref_products`, `ref_templates`, `ref_template_defaults` без внешних ключей на шаблоны (надгробие удалённого шаблона приходит раньше товаров, у которых снята ссылка; шаблон может лежать в карантине); архивные товары и выключенные шаблоны хранятся с признаками; `ENTITIES` и подъём `SYNC_SCHEMA_VERSION`; бюджет порции 3E + 6 при E = 8 — 30 операторов из 32;
  - `spec` в копии — один связанный параметр JSON: лимиты `local_transaction` (`MAX_STATEMENTS` 32, `MAX_SQL_BYTES` 64 КиБ текста SQL, `MAX_VALUES` 256) считают текст SQL и число значений, а не размер значения, поэтому 256 КБ одного значения проходят. Нового потолка не нужно: порция ленты ограничена `MAX_PAGE_BYTES` (1 МиБ), клиент хоста в оболочке читает ответ целиком без своего предела (`host_client.rs`), а `PinnedClient` ждёт ответа до 10 с, чего в локальной сети хватает с запасом. Больше 1 МиБ бывает только одна ревизия в порции: мастер (тело запроса ограничено 2 МБ axum по умолчанию) и удаление шаблона, снимающее ссылку у многих товаров (около 400 байт на товар), — её стоит измерить в тесте планировщика 1e2;
  - товарные группы на станции: в ленту они не входят — засев в миграции оболочки (тогда тест сверки с облачным `0099`, как у хоста), константа вебвью или маршрут устройства;
  - хост возвращает `spec` с ключами в порядке байтов: всё, что считает дайджест текста макета, обязано его канонизировать (снимки макета в сменах — план 2a).
- План 1e3 (экраны шаблонов и мастер):
  - мастер шлёт `templates`: `buildDefaultLabelTemplates()`, `buildDuplicateLabelTemplates()` и `buildPalletLabelTemplates()` (20 шаблонов, потолок хоста 32) с `orgDefault` у `DEFAULT_BOX_LABEL_TEMPLATE_NAME` и `PALLET_LABEL_TEMPLATE_NAME`; в облаке умолчания дубликата нет — назначать ли его в мастере, решает владелец;
  - экраны шаблонов следуют правилам хоста: у типового шаблона не меняются имя и макет, удаления нет, копия — `POST`; сводка списка может нести `null` в размере, разрешении и языке; отказ `template_is_default` объясняет, где стоит умолчание (`organizationDefault`, `categoryDefaults`).
- План 2a: разрешение шаблона смены на станции — пожелание товара, если подходит (`fits`), затем умолчание категории, затем организации, затем выбор оператора; снимок макета в смене.
- Решения владельца ждут:
  - оставить ли шаблоны товара по умолчанию (спецификация §4.3) — в облаке их нет с 2026-09-02;
  - умолчания дубликата: в облаке нет ни умолчания организации, ни умолчаний категорий для дубликата; спецификация и этот план их держат;
  - потолки вместимостей (100 000 штук в коробе, 10 000 коробов на паллете) — облако их не ограничивает;
  - ложная устаревшая запись умолчаний после правки профиля организации (решение 3) — если мешает, нужен отдельный столбец ревизии умолчаний.
