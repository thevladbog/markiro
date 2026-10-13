# План ТОВ: карточка товара в автономе — код ЕГАИС на этикетках, контрагент по умолчанию, фото на «Бланке смены» (хост, протокол, снимок смены, станция, офис, перенос из облака) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У клиентов автонома есть пиво и сидр (решение владельца ПР-6, 2026-10-13), а этикетка короба
и паллеты в автономе печатает строку «ЕГАИС» пустой. Все места сборки полей этикетки на станции
жёстко ставят `egaisCode: null` («no alcohol in stage 2a»), в каталоге хоста кода ЕГАИС нет, а
перенос из облака его отбрасывает. После плана:

- в карточке товара есть «Код ЕГАИС» (только для товарной группы 15 «Пиво…», как в облаке),
  «Контрагент по умолчанию» и фото;
- хост замораживает код ЕГАИС в снимке смены при открытии;
- станция печатает его на этикетках короба и паллеты, на листе A4 и при складской перепечатке —
  так же, как облачная станция;
- планирование смены подставляет контрагента товара;
- «Бланк смены» показывает фото товара;
- перенос из облака (ИМП) приносит код ЕГАИС и контрагента по умолчанию.

**Architecture:**

- **Хост:**
  - миграция `0023_product_egais_photo.sql`: `products.egais_code`, `products.default_counterparty_id`,
    таблица `product_photos`;
  - правила товара: ЕГАИС только при группе 15; контрагент — существующий и не в архиве;
  - маршруты фото `GET|PUT|DELETE /v1/office/products/{id}/photo` по образцу `org_logo.rs`: хост
    не разбирает картинку, проверяет только сигнатуру JPEG и размеры;
  - снимок смены (`shifts::snapshot`) замораживает `egaisCode`.
- **Протокол:**
  - поля в `OfficeProduct`, `ProductCreate`, `ProductUpdate`;
  - `ShiftSnapshotProduct.egais_code` с `#[serde(default)]`;
  - типы фото;
  - формат файла ИМП 2 (хост читает 1 и 2).

  Версия протокола устройства **не растёт**. Правило `proto/src/lib.rs:16-19` поднимает её только
  на новый вид факта или новое поле `data` факта. Здесь новое поле — в ответе (снимок), а ответы
  терпят неизвестные поля. Старая станция поле не прочитает и напечатает пусто, как сегодня.

- **Станция:** четыре боевых места сборки полей берут `snapshot.product.egaisCode`. Складская
  перепечатка получает код из ответа поиска, а это снимок смены найденного короба. Образцы
  (предпросмотр листа, тестовая печать A4) остаются без кода.
- **Офис:** поля в карточке товара, фото со сжатием в webview, подстановка контрагента в диалоге
  смены, фото на «Бланке смены» через `data:`-URL. Доменный рендер получает необязательное поле
  `imageSrc`; без него вывод для облака побайтово прежний.
- **ИМП:** `tools/standalone-export/export.sql` выгружает `egaisCode` и `defaultCounterpartyId`
  значениями, а не в `lost`. `transform.mjs` и `host/src/cloud_import.rs` их переносят. Фото
  остаётся потерей (вопрос ТОВ-1).

**Tech Stack:** Rust (axum, sqlx 0.8.6, serde, sha2, base64) — `host`, `proto`; React 19.2,
TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, i18next,
react-hook-form, `@markiro/ui` (`Input`, `Select`, `Checkbox`, `Button`, `Alert`), `@markiro/domain`
(`boxLabelFields`, `palletLabelFields`, `isEgaisApplicable`, `EGAIS_PRODUCT_GROUP_CODE`,
`renderShiftTaskFormHtml`), Vitest 4 (jsdom, `node:sqlite` за `LocalExecutor`), Node `node:test` для
`tools/standalone-export`.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` — §5.5 (раздел ТОВ),
  строки П-24 и П-08, решение ПР-6.
- `docs/superpowers/specs/2026-09-26-standalone-station-design.md` §10.1 («Каталог … фото»).
- Облако, образец:
  - `apps/api/src/modules/products/{dto.ts,products.service.ts,product-writer.ts}` — `egaisCode`
    1–64 символа;
  - `apps/api/src/modules/product-regulatory/{proposal-schema.ts,product-regulatory.service.ts:426}` —
    основной код зеркалится в `products.egais_code`;
  - `apps/admin/src/pages/catalog/ProductForm.tsx` — поле ЕГАИС только для применимой группы;
  - `packages/domain/src/product-attributes/egais.ts` — `EGAIS_PRODUCT_GROUP_CODE = 15`,
    `isEgaisApplicable`;
  - `apps/station/src/lib/mirror.ts:455` и `offline-grants/semantic.ts:207` — станция берёт код
    из зеркала товара и замораживает в снимке;
  - `packages/domain/src/labels/{box-label.ts:103,pallet-label.ts,defaults.ts:534,pallet-sheet-render.ts}` —
    поле `product.egais`;
  - `packages/domain/src/print-forms/shift-task-form.ts:145` — фото на бланке.
- `apps/standalone/AGENTS.md`: «Catalog and label templates», «Cloud import», «Shifts», «Floor
  printing», «Warehouse reprint», «Shift card and printed forms», «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `578906ef2`)

- **Хост.**
  - `host/migrations/0008_catalog.sql:91-110` — у `products` нет ЕГАИС, контрагента и фото.
  - `host/src/routes/products.rs`: `Sent` → `Fields` (`validate`), `check_references` (группа,
    шаблоны), `create_product`/`update_product` с `audit::update_details`, аудит
    `product.create`/`product.update` (`host/src/audit.rs:40-41`).
  - `host/src/shifts.rs:467-578` `snapshot` читает `gtin14, name, print_name, chz_group_code,
shelf_life_days` и строит `ShiftSnapshotProduct`.
  - `host/src/routes/warehouse.rs:84` кладёт в ответ поиска `ShiftSnapshotProduct` из снимка смены.
- **Протокол.**
  - `proto/src/lib.rs:1289-1352` — `OfficeProduct`, `ProductCreate`, `ProductUpdate` (запросы с
    `deny_unknown_fields`).
  - `:1782-1789` — `ShiftSnapshotProduct` без ЕГАИС.
  - `proto/src/cloud_import.rs:19` — `CLOUD_IMPORT_FORMAT_VERSION = 1`; `:121` — `CloudProduct`
    (`deny_unknown_fields`).
  - `host/src/cloud_import.rs:136` — версия сверяется на равенство.
- **Zod** (`src/host/protocol.ts`):
  - `officeProductSchema` — `:530`;
  - `productCreateSchema`, `productUpdateSchema` (`.strict()`) — `:1294-1328`;
  - `shiftSnapshotProductSchema` (`z.object`) — `:838`, его же использует `warehouseSourceSchema`
    (`:1042`).
  - `src/host/requests.ts:205-258` — `ProductInput`, `productCreate`, `productUpdate`.
- **Станция** — пять мест `egaisCode: null`:
  - `src/floor/print/label-render.ts:59` (короб) и `:89` (паллета);
  - `src/floor/print/shift-render.ts:69` (лист A4 смены);
  - `src/floor/warehouse/warehouse-work.ts:260` (складская перепечатка);
  - `src/labels/sheet-render.ts:50` — образец предпросмотра;
  - ещё `src/floor/setup/a4-test.ts:60` — тестовая печать.

  `CheckedSnapshot.product` имеет тип `ShiftSnapshot["product"]`
  (`src/floor/shifts/shift-snapshot.ts:19-30`).

- **Офис.**
  - `src/office/products/{ProductDialog.tsx,product-form.ts}` — полей ЕГАИС, контрагента и фото нет.
  - Редактор шаблона предупреждает о поле ЕГАИС вне группы 15
    (`src/office/templates/editor-model.ts:171`).
  - `src/office/forms/form-data.ts:177-208` — `imageChecksum: null`.
- **ИМП.**
  - `tools/standalone-export/export.sql:68-81` пишет `egaisCode`, `defaultCounterparty`, `photo` и
    `price` только в `lost`.
  - `transform.mjs:370-422` превращает их в заметку `product_fields_lost`.
  - `src/office/import/import-notes.ts:56` показывает её.
- **Стоковый шаблон короба** (`packages/domain/src/labels/defaults.ts:534-546`) уже печатает
  подпись «ЕГАИС» и поле `product.egais`.

## Решения владельца

- **ПР-6 (2026-10-13):** «клиенты с ЕГАИС есть». ТОВ обязателен в волне 1, до выпуска MVP для
  этих клиентов. В него входят: код ЕГАИС на этикетках станции, перенос кода из облака, фото на
  «Бланке смены», контрагент по умолчанию.
- Цена товара не переносится: она нужна только выбытию, а выбытия в автономе нет (§6 спецификации
  паритета).

## Допущения

- **Р1 — один код ЕГАИС на товар.** Облако хранит список до 20 кодов с основным, но на этикетку
  и в зеркало станции идёт только основной (`products.egais_code`). В автономе — одно поле:
  ровно то, что печатается. Правило длины облачное: после обрезки пробелов 1–64 символа, без
  управляющих символов. Девятнадцати цифр не требуем: облачное поле их тоже не требует, а старые
  товары клиента могут нести другой формат. Офис подсказывает «обычно 19 цифр».
- **Р2 — ЕГАИС только у группы 15.** Хост отвечает `validation_failed` на поле `egaisCode`, если
  код задан у товара другой группы или без группы. Офис прячет и очищает поле, когда группа
  меняется с 15 на другую. Перенос из облака код у товара другой группы снимает с заметкой
  `product_value_cleared` (поле `egaisCode`).
- **Р3 — код замораживается в снимке.** Как облачная станция (`offline-grants/semantic.ts`):
  правка каталога не меняет идущую смену, перепечатка ставит тот же код, что первая печать.
  Лента изменений к станции код не несёт, поэтому миграции оболочки нет. Номер `0016` за ТОВ не
  закреплён.
- **Р4 — контрагент по умолчанию.**
  - Ссылка на `counterparties`; при записи — существующий и не в архиве
    (`shifts::check_counterparty`).
  - Позже его можно архивировать: товар хранит ссылку, диалог смены такого не подставляет.
  - Подстановка: при выборе товара в диалоге смены, если поле контрагента пусто. Выбор
    пользователя не перетирается.
- **Р5 — фото хранится на хосте байтами.**
  - Офис сжимает картинку в webview до JPEG не больше 640 × 640 и 300 000 байт, качество 0,85
    (`canvas.toBlob`).
  - Хост проверяет сигнатуру JPEG (`FF D8 FF`), размеры и длину и хранит одну строку на товар.
  - Хост картинку не разбирает, как логотип (`org_logo.rs`).
  - Фото не идёт на станцию и в ленту изменений, ревизию товара не трогает: у него свой маршрут.
  - Список товаров получает `photoChecksum` (SHA-256 байт), чтобы показывать, есть ли фото, без
    передачи байт.
  - Резервная копия хоста копирует файл базы целиком, поэтому фото в неё входит.
- **Р6 — фото на «Бланке смены».** Доменный `ShiftTaskFormData` получает необязательное
  `imageSrc?: string`. Если поле задано, `<img src>` берёт его (через `escapeHtml`); иначе
  остаётся прежняя относительная ссылка облака. Облако поле не передаёт, и его вывод побайтово
  прежний — это проверяет эталонный тест в `packages/domain`. Офис передаёт `data:image/jpeg;base64,…`
  и `imageChecksum` из фото.
- **Р7 — формат файла ИМП 2.**
  - `CloudProduct` получает `egaisCode` и `defaultCounterpartyId` с `#[serde(default)]`.
  - Хост читает форматы 1 и 2 (`matches!(v, 1 | 2)`): старые файлы, уже сделанные у клиента,
    остаются годными.
  - Инструмент пишет 2. Сырой формат `export.sql` (`raw.formatVersion`) тоже 2, `transform.mjs`
    читает 1 и 2.
- **Р8 — фото из облака не переносится (вопрос ТОВ-1).** Облачные картинки лежат в объектном
  хранилище (`product_images` → `media_assets`), а инструмент читает только Postgres через psql.
  Заметка `product_fields_lost` с полем `photo` остаётся. Фото загружается в офисе вручную.

## Global Constraints

**Правила продукта**

- Офлайн-первым: код ЕГАИС едет к станции только в снимке смены; ни печать, ни перепечатка не
  ходят за ним на хост, кроме складской перепечатки, которая и сегодня ищет запись на хосте.
- Снимок замораживает код при открытии смены; каталог не меняет идущую смену.
- Старые записи совместимы: снимок без `egaisCode` (смена, открытая до обновления) читается как
  `null`; файл ИМП формата 1 принимается.
- Аудит: у каждой записи точные исполнитель, действие, цель и результат. Тесты сверяют
  `product.update` с полями `egaisCode` и `defaultCounterpartyId`, `product.photo.set` и
  `product.photo.clear` без байт картинки.
- Права: фото и поля товара пишут администратор и технолог (`require_catalog`, как прочие поля
  товара). Читают все офисные роли. Устройство без офисной сессии — `unauthorized`.

**Миграции и протокол (распределение 2026-10-13)**

- Миграции хоста, уже занятые открытыми ветками: `0017` сотрудники (fb-people), `0018` умолчания
  листов A4 (fb-templates), `0019` поиск кодов (fb-codesearch), `0020`–`0021` режимы смены (РЕЖ).
  Миграции оболочки: `0014`–`0015` (РЕЖ). В базе применены: хост `0001`–`0012`, `0015`, `0016`;
  оболочка `0001`–`0010`, `0012`, `0013`.
- Распределение волны 1 паритета: КНФ — хост `0022`, оболочка `0016`; ТОВ — хост `0023`; ДЗГ —
  хост `0024`, оболочка `0017`; ДЗГ-О — нет; КРТ — хост `0025`; ИСТ — хост `0026`. Неиспользованный
  номер остаётся пропуском. Перед задачей миграции исполнитель заново смотрит
  `ls apps/standalone/{host,src-tauri}/migrations` в `claude/integration` и открытых ветках
  `claude/fb-*`; если номер занят — берёт следующий свободный и пишет это в «Отклонения».
- Индексы на `scans` / `code_owners` — только миграциями после `0020`: РЕЖ (часть A) перестраивает
  обе таблицы и пересоздаёт только свои индексы и индексы поиска кодов. Запросы работают при
  `code_owners.box_id` = NULL (смены проверки).
- Протокол устройства: в базе `PROTOCOL_VERSION = 3`, РЕЖ берёт 4 и 5. Резерв на случай подъёма по
  правилу `proto/src/lib.rs:16-19` (новый вид факта или новое поле `data` факта; ответы терпят
  неизвестные поля): КНФ 6, ТОВ 7, ДЗГ 8, ИСТ 9. Без нужды не поднимать; при слиянии константа
  берёт наибольший номер. **ТОВ версию не поднимает** (Р3: новое поле только в ответе).
- **Стык с fb-templates.** Ветка правит те же фикстуры товара (`office-product.json`,
  `product-create.json`, `product-update.json`) и `host/src/routes/products.rs`. ТОВ начинается
  после её слияния в `claude/integration`. Если она ещё не влита — задача 1, шаг 0 останавливает
  исполнение и сообщает контроллеру.

**Код и процесс**

- TypeScript strict: без `any`, приведений и `!`; именованные экспорты, `import type`.
- Офис — `@markiro/ui`, мышь и клавиатура, видимый фокус, подписи у полей. Строки — только
  `src/i18n/ru.json` (английского файла в `apps/standalone` нет — проверить
  `ls apps/standalone/src/i18n`).
- Формы на проводе — фикстуры `proto/fixtures`, их читают Rust (`proto/tests/*.rs`) и Vitest
  (`test/protocol.test.ts`).
- Rust: `cargo fmt` чистый, без предупреждений. `Cargo.toml`, `Cargo.lock`, `package.json`,
  `pnpm-lock.yaml` не меняются.
- `packages/domain` меняется только в задаче 6 (необязательное поле), с эталоном вывода облака.
  `apps/api`, `apps/admin`, `apps/station` не меняются.
- Новые миграции — только новыми файлами. Никогда `git stash`. Коммиты с явными путями, трейлер
  одной строкой `Co-Authored-By: …`. Push и PR — не в этом плане.

## Заметки для исполнения

- Worktree от `claude/integration` (после слияния fb-templates). Зависимости — клоны APFS из
  `/tmp/claude/wt/integ`: `cp -c -R -P` для `node_modules`, `apps/standalone/node_modules`,
  `packages/*/node_modules`, `packages/*/dist`; для cargo — ещё `apps/standalone/target`.
- Команды (`<wt>` — абсолютный путь worktree):
  - Vitest: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run <файлы>`;
  - пакет: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
    (а также `typecheck`, `lint`);
  - домен: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/print-forms-snapshot.test.ts test/shift-task-form.test.ts`,
    затем `… --filter @markiro/domain build` перед тестами автонома;
  - инструмент ИМП: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false test:standalone-export`;
  - Rust: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-host --test products`
    (имена крейтов проверить в `apps/standalone/Cargo.toml` и `host/Cargo.toml`), `-p markiro-proto`;
    `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`.
- Интеграционные тесты хоста на `TestApp` сокета не открывают. Песочница нужна только тестам с
  loopback.
- React-тесты диалогов (задачи 5, 6) прогоняются дважды: один раз с `--reporter=verbose` без
  `stderr |`, второй раз под стендом с задержкой `setImmediate` на 3 мс. Стенд — временные
  `test/delayed-immediate.setup.ts` и `vitest.delay.config.ts`, как в плане СКЛ; после прогона
  удалить.
- Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.

## Файлы

- **Создать:**
  - `apps/standalone/host/migrations/0023_product_egais_photo.sql`;
  - `apps/standalone/host/src/routes/product_photos.rs`;
  - `apps/standalone/host/tests/product_photos.rs`;
  - `apps/standalone/proto/fixtures/{product-photo-put,product-photo-state,office-product-egais}.json`;
  - `apps/standalone/src/office/products/{ProductPhotoField.tsx,photo-encode.ts}`;
  - `apps/standalone/test/{product-photo,label-egais}.test.ts(x)`.
- **Изменить:**
  - `proto/src/lib.rs`, `proto/src/cloud_import.rs`, `proto/tests/*.rs`;
  - фикстуры `office-product.json`, `product-create.json`, `product-update.json`,
    `device-shift-entered*.json`, `warehouse-lookup-found-*.json`, `cloud-export-file.json`;
  - `host/src/{validate.rs,audit.rs,shifts.rs,server.rs,cloud_import.rs}`,
    `host/src/routes/{products.rs,mod.rs,cloud_import.rs}`,
    `host/tests/{products.rs,device_shifts.rs,warehouse.rs,cloud_import.rs}`;
  - `src/host/{protocol.ts,requests.ts,api.ts}`;
  - `src/floor/print/{label-render.ts,shift-render.ts}`, `src/floor/warehouse/warehouse-work.ts`;
  - `src/office/products/{ProductDialog.tsx,product-form.ts,ProductsPage.tsx}`;
  - `src/office/shifts/ShiftDialog.tsx`, `src/office/forms/{form-data.ts,task-inputs.ts}`;
  - `src/office/import/import-notes.ts`, `src/i18n/ru.json`;
  - тесты `test/{protocol,api,product-dialog,product-form,products-page,shift-dialog,print-form,print-form-dialog,floor-label-render,warehouse-work,cloud-import-page}.test.ts(x)`;
  - `packages/domain/src/print-forms/shift-task-form.ts`, `packages/domain/test/shift-task-form.test.ts`;
  - `tools/standalone-export/{export.sql,transform.mjs}`, `tools/standalone-export/test/{transform,export-sql,cli}.test.mjs`
    и `test/fixtures/{seed-cloud.sql,raw-cloud.json}`;
  - `apps/standalone/AGENTS.md`.

---

## Задача 1: протокол и Zod — ЕГАИС, контрагент, фото, снимок

**Files:** Modify `apps/standalone/proto/src/lib.rs`, `apps/standalone/src/host/protocol.ts`,
`apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`; фикстуры
`office-product.json`, `product-create.json`, `product-update.json`, `device-shift-entered.json`,
`device-shift-entered-pallets.json`, `device-shift-entered-sheet.json`,
`warehouse-lookup-found-unit.json`, `warehouse-lookup-found-pallet.json`; Create
`product-photo-put.json`, `product-photo-state.json`, `office-product-egais.json`; тесты
`proto/tests/catalog.rs` (или файл, где сегодня читаются фикстуры товара — найти
`rtk proxy grep -ln "office-product.json" apps/standalone/proto/tests`), `test/protocol.test.ts`,
`test/api.test.ts`.

**Interfaces (Rust):**

```rust
// OfficeProduct: after default_pallet_template_id
pub egais_code: Option<String>,
pub default_counterparty_id: Option<String>,
/// SHA-256 of the photo's bytes in lower-case hex, `null` without a photo
/// (the bytes come from `GET /v1/office/products/{id}/photo`).
pub photo_checksum: Option<String>,

// ProductCreate and ProductUpdate: after default_pallet_template_id
#[serde(default)]
pub egais_code: Option<String>,
#[serde(default)]
pub default_counterparty_id: Option<String>,

// ShiftSnapshotProduct: after shelf_life_days
/// The product's EGAIS code as the shift froze it (plan ТОВ): only a product
/// of ЧЗ group 15 has one. Left out by a host before plan ТОВ.
#[serde(default)]
pub egais_code: Option<String>,

/// A product's photo (plan ТОВ): a JPEG the office made, at most 640 × 640
/// and 300 000 bytes, in standard base64 with padding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPhoto {
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
    pub checksum: String,
    pub updated_at: String,
}

/// `GET`, `PUT` and `DELETE /v1/office/products/{id}/photo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPhotoState {
    pub photo: Option<ProductPhoto>,
}

/// `PUT /v1/office/products/{id}/photo`: the whole photo, replacing any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductPhotoPut {
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
}
```

`#[serde(default)]` у `ShiftSnapshotProduct.egais_code` обязателен: снимки смен, открытых до
обновления, лежат в `shifts.snapshot` хоста и в базе станции, и они должны читаться. У
`OfficeProduct` поля обязательны: это ответ хоста той же сборки.

**Interfaces (TS, `src/host/protocol.ts`):**

```ts
/** A product's EGAIS code as the host keeps it (plan ТОВ, the cloud's `egaisCode`). */
export const egaisCodeSchema = z.string().min(1).max(64);

// officeProductSchema: add
egaisCode: egaisCodeSchema.nullable(),
defaultCounterpartyId: z.uuid().nullable(),
photoChecksum: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),

// productCreateSchema / productUpdateSchema (.strict()): add
egaisCode: egaisCodeSchema.nullable(),
defaultCounterpartyId: z.uuid().nullable(),

// shiftSnapshotProductSchema: add — optional, a snapshot of an older host has none
egaisCode: egaisCodeSchema.nullable().optional(),

export const productPhotoSchema = z.object({
  width: z.number().int().min(1).max(640),
  height: z.number().int().min(1).max(640),
  dataBase64: z.string().min(4),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  updatedAt: z.string(),
});
export const productPhotoStateSchema = z.object({ photo: productPhotoSchema.nullable() });
export const productPhotoPutSchema = z
  .object({
    width: z.number().int().min(1).max(640),
    height: z.number().int().min(1).max(640),
    dataBase64: z.string().min(4),
  })
  .strict();
export type ProductPhoto = z.infer<typeof productPhotoSchema>;
export type ProductPhotoPut = z.infer<typeof productPhotoPutSchema>;
```

`ProductInput` (`requests.ts`) получает `egaisCode: string | null` и
`defaultCounterpartyId: string | null`; `productCreate`/`productUpdate` переносят оба. `HostApi`
получает три метода:

```ts
getProductPhoto: (token: string, id: string) => Promise<ProductPhotoState>;
putProductPhoto: (token: string, id: string, put: ProductPhotoPut) => Promise<ProductPhotoState>;
deleteProductPhoto: (token: string, id: string) => Promise<ProductPhotoState>;
```

Пути — `/v1/office/products/${id}/photo`, по образцу `getOrgLogo`/`putOrgLogo`/`deleteOrgLogo`
(`src/host/api.ts:347-361`).

- [ ] **Шаг 0: стык с fb-templates.** `git -C <wt> log --oneline claude/integration -- apps/standalone/proto/fixtures/office-product.json`
      должен показать коммит fb-templates. Если его нет — остановиться и сообщить контроллеру.
- [ ] **Шаг 1: фикстуры (сначала, красные тесты читают их).**
  - `office-product.json` — к существующему объекту добавить `"egaisCode": null,
"defaultCounterpartyId": null, "photoChecksum": null`.
  - `office-product-egais.json` — товар группы 15:
    ```json
    {
      "id": "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f",
      "gtin14": "04607001234560",
      "name": "Пиво светлое фильтрованное 0,5 л",
      "printName": "Пиво светлое 0,5",
      "chzProductGroupCode": 15,
      "boxCapacity": 20,
      "palletBoxCapacity": 60,
      "shelfLifeDays": 180,
      "defaultBoxTemplateId": null,
      "defaultPalletTemplateId": null,
      "egaisCode": "0150320000001234567",
      "defaultCounterpartyId": "0b9e7c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d",
      "photoChecksum": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "archived": false,
      "status": "active",
      "rev": 7
    }
    ```
  - `product-create.json`, `product-update.json` — добавить `"egaisCode": null,
"defaultCounterpartyId": null`.
  - Три `device-shift-entered*.json` — в `snapshot.product` добавить `"egaisCode": null`.
  - Два `warehouse-lookup-found-*.json` — в `product` добавить `"egaisCode": null`.
  - `product-photo-put.json` — `{ "width": 2, "height": 1, "dataBase64": "/9j/4AAQSkZJRgABAQ==" }`
    (сигнатура JPEG; полный разбор картинки хост не делает).
  - `product-photo-state.json` — `{ "photo": { … "checksum": "<sha256 тех байт>",
"updatedAt": "2026-10-13T09:00:00.000Z" } }`. Контрольную сумму посчитать командой
    `printf '/9j/4AAQSkZJRgABAQ==' | base64 -d | shasum -a 256` и вписать.
- [ ] **Шаг 2: красные тесты.**

  Rust (`proto/tests`):

  ```rust
  #[test]
  fn a_snapshot_of_a_host_before_plan_tov_reads_without_an_egais_code() {
      let mut entered: serde_json::Value = fixture("device-shift-entered.json");
      entered["snapshot"]["product"].as_object_mut().unwrap().remove("egaisCode");
      let shift: DeviceShift = serde_json::from_value(entered).unwrap();
      assert_eq!(shift.snapshot.unwrap().product.egais_code, None);
  }

  #[test]
  fn the_product_fixtures_round_trip() {
      for name in ["office-product.json", "office-product-egais.json"] {
          round_trip::<OfficeProduct>(name);
      }
      round_trip::<ProductCreate>("product-create.json");
      round_trip::<ProductUpdate>("product-update.json");
      round_trip::<ProductPhotoPut>("product-photo-put.json");
      round_trip::<ProductPhotoState>("product-photo-state.json");
  }

  #[test]
  fn a_photo_put_refuses_an_unknown_field() {
      let mut put: serde_json::Value = fixture("product-photo-put.json");
      put["mime"] = serde_json::json!("image/png");
      assert!(serde_json::from_value::<ProductPhotoPut>(put).is_err());
  }
  ```

  Помощники `fixture` и `round_trip` взять из соседнего файла тестов `proto/tests`; если их нет —
  написать по образцу ближайшего теста фикстур.

  Vitest (`test/protocol.test.ts`): те же фикстуры через схемы. `shiftSnapshotProductSchema` без
  `egaisCode` проходит и даёт `undefined`. `productPhotoPutSchema` отказывает лишнему полю.
  `productCreate({ …, egaisCode: "0150320000001234567", defaultCounterpartyId: null })` совпадает
  с ожидаемым телом.

  `test/api.test.ts`: `putProductPhoto` шлёт `PUT /v1/office/products/<id>/photo` с телом и
  читает ответ схемой — по образцу теста `putOrgLogo`.

  Прогон (должен упасть):
  - `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-proto`;
  - `pnpm … --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`.

- [ ] **Шаг 3: реализация** типов, схем, `requests.ts` и `api.ts` по интерфейсам выше.
      `ProductInput` расширяется, поэтому typecheck укажет на `toProductInput`
      (`product-form.ts`): пока задача 5 не заполнила поля, там ставится
      `egaisCode: null, defaultCounterpartyId: null`.
- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, typecheck, коммит**
      `feat(standalone): product EGAIS code, default counterparty and photo on the wire; the snapshot's EGAIS code`.

## Задача 2: хост — миграция `0023`, правила товара, маршруты фото

**Files:** Create `apps/standalone/host/migrations/0023_product_egais_photo.sql`,
`apps/standalone/host/src/routes/product_photos.rs`, `apps/standalone/host/tests/product_photos.rs`;
Modify `host/src/routes/products.rs`, `host/src/routes/mod.rs`, `host/src/server.rs`,
`host/src/validate.rs`, `host/src/audit.rs`, `host/tests/products.rs`,
`host/tests/backup_schema.rs` (или тест, который сверяет схему и журнал миграций — найти
`rtk proxy grep -ln "MIGRATOR" apps/standalone/host/tests`).

**Interfaces:**

```rust
// validate.rs
/// A product's EGAIS code (plan ТОВ, the cloud's `egaisCode`): trimmed, 1 to
/// 64 characters, no control characters; `None` for none.
pub fn egais_code(field: &str, value: Option<&str>) -> Result<Option<String>, ApiError>;
/// A product photo's JPEG: standard base64 of at most `MAX_PHOTO_BYTES`
/// bytes that start with `FF D8 FF`, within 1..=640 on each side.
pub const MAX_PHOTO_BYTES: usize = 300_000;
pub fn product_photo(width: u32, height: u32, data_base64: &str) -> Result<Vec<u8>, ApiError>;

// audit.rs actions
pub const PRODUCT_PHOTO_SET: &str = "product.photo.set";
pub const PRODUCT_PHOTO_CLEAR: &str = "product.photo.clear";

// routes/product_photos.rs
pub async fn get_photo(State, OfficeContext, ApiPath<String>) -> Result<Json<ProductPhotoState>, ApiError>;
pub async fn put_photo(State, OfficeContext, ApiPath<String>, ApiJson<ProductPhotoPut>) -> Result<Json<ProductPhotoState>, ApiError>;
pub async fn delete_photo(State, OfficeContext, ApiPath<String>) -> Result<Json<ProductPhotoState>, ApiError>;
```

- [ ] **Шаг 1: миграция (сначала красный тест схемы).** Тест: после `MIGRATOR`
      `PRAGMA table_info(products)` содержит `egais_code` и `default_counterparty_id`.
      `INSERT` в `product_photos` с `length(data) = 300001` отказывает по CHECK. Удаление товара с
      фото невозможно, но товары и так не удаляются — проверка внешнего ключа: `PRAGMA
foreign_key_check` пуст.

  ```sql
  -- A product's EGAIS code, default counterparty and photo (plan ТОВ, parity
  -- spec §5.5). The EGAIS code is the one the labels print (the cloud's
  -- `products.egais_code`, its regulatory profile's primary code): trimmed,
  -- 1 to 64 characters; only a product of ЧЗ group 15 carries one — the
  -- host's rule (`routes/products.rs`), as the group may still change.
  -- The default counterparty is a preference the office's shift dialog
  -- offers; a counterparty archived later stays named here.
  ALTER TABLE products ADD COLUMN egais_code TEXT
    CHECK (egais_code IS NULL OR length(trim(egais_code)) BETWEEN 1 AND 64);
  ALTER TABLE products ADD COLUMN default_counterparty_id TEXT
    REFERENCES counterparties (id);
  CREATE INDEX products_default_counterparty ON products (default_counterparty_id);

  -- A product's photo: one JPEG the office made (at most 640 × 640 and
  -- 300 000 bytes). Not in the station feed and not in a shift's snapshot;
  -- a change takes no catalog revision. `checksum` is SHA-256 of `data` in
  -- lower-case hex.
  CREATE TABLE product_photos (
    product_id TEXT PRIMARY KEY REFERENCES products (id),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 640),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 640),
    data BLOB NOT NULL CHECK (length(data) BETWEEN 4 AND 300000),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
    updated_at TEXT NOT NULL
  );
  ```

  SQLite разрешает `ADD COLUMN` с `REFERENCES` при значении по умолчанию NULL и с CHECK. Тест
  проверяет, что миграция применяется на базе с товарами: строки остаются, новые поля `NULL`.

- [ ] **Шаг 2: красные тесты правил товара** (`host/tests/products.rs`, стиль файла: `admin()`,
      `create`, `milk()`, `milk_record`, `audit_trail`):

  ```rust
  /// A beer product (ЧЗ group 15) with an EGAIS code.
  fn beer() -> Value {
      json!({
          "gtin14": "04607001234560", "name": "Пиво светлое 0,5 л",
          "chzProductGroupCode": 15, "boxCapacity": 20, "palletBoxCapacity": 60,
          "egaisCode": " 0150320000001234567 "
      })
  }

  #[tokio::test]
  async fn a_beer_product_keeps_its_trimmed_egais_code() {
      let admin = admin().await;
      let created = create(&admin, beer()).await;
      assert_eq!(created["egaisCode"], "0150320000001234567");
      assert_eq!(created["photoChecksum"], Value::Null);
  }

  #[tokio::test]
  async fn an_egais_code_outside_group_15_is_refused() {
      let admin = admin().await;
      let mut body = milk(); // group 8
      body["egaisCode"] = json!("0150320000001234567");
      let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
      assert_eq!(status, StatusCode::BAD_REQUEST);
      assert_eq!(error["error"]["details"]["field"], "egaisCode");
  }

  #[tokio::test]
  async fn changing_the_group_away_from_15_with_the_code_kept_is_refused() { /* PUT group 8 + code → 400 egaisCode */ }

  #[tokio::test]
  async fn an_egais_code_of_65_characters_or_with_a_control_character_is_refused() { /* 400 validation_failed */ }

  #[tokio::test]
  async fn the_default_counterparty_must_be_in_use() {
      // an unknown id → 400 defaultCounterpartyId; an archived counterparty → 400;
      // an active one → saved; archiving it later keeps the product's pointer
  }

  #[tokio::test]
  async fn the_update_audits_the_egais_code_and_the_counterparty() {
      let admin = admin().await;
      let created = create(&admin, beer()).await;
      let mut body = full(&created, created["rev"].as_i64().unwrap());
      body["egaisCode"] = json!("0150320000007654321");
      let (status, _) = admin.call("PUT", &path(&created), Some(body)).await;
      assert_eq!(status, StatusCode::OK);
      let trail = audit_trail(&admin.app, "product.update").await;
      assert_eq!(trail.len(), 1);
      assert_eq!(
          trail[0].details["egaisCode"],
          json!({ "from": "0150320000001234567", "to": "0150320000007654321" })
      );
  }
  ```

  Ошибка поля у хоста — `400 validation_failed` с `details.field` (`host/src/error.rs:88`); путь к полю
  сверить с существующими тестами `validation_failed` в этом файле (например, тестом GTIN). Форму `details` у `update_details` — с соседним тестом аудита
  обновления. `milk_record` получает три новых поля со значением `null`.

- [ ] **Шаг 3: красные тесты фото** (`host/tests/product_photos.rs`):
  - `GET` товара без фото — `{ "photo": null }`;
  - `PUT` фикстуры `product-photo-put.json` — ответ с `checksum` = SHA-256 байт, `GET` отдаёт то
    же; `photoChecksum` в `GET /v1/office/products` совпадает;
  - `PUT` технологом проходит; устройство без сессии — `401`;
  - PNG (`iVBORw0KGgo=`) — `400` `validation_failed`, поле `dataBase64`; 300 001 байт — `400` `validation_failed`; ширина 641 — `400` `validation_failed`
    `width`; кривой base64 — `400` `validation_failed`; неизвестный товар — `404`;
  - ревизия хоста (`host_revision`) после `PUT` не меняется;
  - аудит `product.photo.set` с `details == {"width":2,"height":1,"bytes":13}` и без base64
    (тест ищет подстроку `"/9j/` в `details` и не находит);
  - `DELETE` — `{ "photo": null }` и аудит `product.photo.clear`; повторный `DELETE` аудита не
    пишет.

  Прогон: `cargo … test -p markiro-host --test products --test product_photos` — красный.

- [ ] **Шаг 4: реализация.**

  `validate.rs`:

  ```rust
  pub fn egais_code(field: &str, value: Option<&str>) -> Result<Option<String>, ApiError> {
      let Some(value) = value else { return Ok(None) };
      let trimmed = value.trim();
      if trimmed.is_empty() {
          return Ok(None);
      }
      if trimmed.chars().count() > 64 || trimmed.chars().any(char::is_control) {
          return Err(ApiError::validation(field, "an EGAIS code is 1 to 64 characters"));
      }
      Ok(Some(trimmed.to_owned()))
  }

  pub fn product_photo(width: u32, height: u32, data_base64: &str) -> Result<Vec<u8>, ApiError> {
      for (field, side) in [("width", width), ("height", height)] {
          if !(1..=640).contains(&side) {
              return Err(ApiError::validation(field, "a photo side is 1 to 640 pixels"));
          }
      }
      // Before decoding: the base64 of MAX_PHOTO_BYTES is at most 400 000 characters.
      if data_base64.len() > 400_000 {
          return Err(ApiError::validation("dataBase64", "a photo is at most 300 000 bytes"));
      }
      let bytes = base64::engine::general_purpose::STANDARD
          .decode(data_base64)
          .map_err(|_| ApiError::validation("dataBase64", "standard base64 is required"))?;
      if bytes.len() > MAX_PHOTO_BYTES || bytes.len() < 4 || !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
          return Err(ApiError::validation("dataBase64", "a JPEG of at most 300 000 bytes is required"));
      }
      Ok(bytes)
  }
  ```

  Как `base64` подключён в хосте, проверить: `rtk proxy grep -n "base64" apps/standalone/host/Cargo.toml apps/standalone/host/src/validate.rs`.
  `mono_logo` уже декодирует base64 — взять тот же импорт. Если крейта нет, `Cargo.toml` не
  трогать, а взять декодер, которым пользуется `mono_logo`.

  `routes/products.rs`:

  - `SELECT` получает `p.egais_code, p.default_counterparty_id, (SELECT checksum FROM
product_photos ph WHERE ph.product_id = p.id) AS photo_checksum` (запрос — `FROM products p`).
  - `ProductRow`/`record` — три поля. `Sent`/`Fields` — `egais_code`, `default_counterparty_id`.
  - `validate()` вызывает `validate::egais_code("egaisCode", self.egais_code)` и правило Р2:

  ```rust
  if egais_code.is_some()
      && !matches!(self.chz_product_group_code, Some(EGAIS_PRODUCT_GROUP_CODE))
  {
      return Err(ApiError::validation(
          "egaisCode",
          "only a product of ЧЗ group 15 carries an EGAIS code",
      ));
  }
  ```

  Константа в хосте — `pub const EGAIS_PRODUCT_GROUP_CODE: u32 = 15;` в `validate.rs`, с
  комментарием-ссылкой на `packages/domain/src/product-attributes/egais.ts`.

  `check_references` в конце:

  ```rust
  if let Some(id) = &fields.default_counterparty_id {
      // The same rule as a shift's counterparty: an existing one in use.
      crate::shifts::check_counterparty(conn, id)
          .await
          .map_err(|_| ApiError::validation("defaultCounterpartyId", "no such counterparty in use"))?;
  }
  ```

  `check_counterparty` сам отвечает ошибкой поля `counterpartyId`. Обёртка меняет имя поля только
  при ошибке валидации; внутреннюю ошибку базы она должна пропускать как есть. Если сигнатура
  этого не позволяет, вынести общий запрос в `shifts::counterparty_in_use(conn, id) ->
Result<bool, ApiError>` и звать его из обоих мест.

  `INSERT`/`UPDATE` получают два столбца. `update_details` — две пары `("egaisCode", …)`,
  `("defaultCounterpartyId", …)`. В деталях создания — `"egaisCode": fields.egais_code`.

  `routes/product_photos.rs` — по образцу `org_logo.rs`, но:
  - права `context.require_catalog()` / `require_catalog_in`;
  - товар должен существовать (`SELECT 1 FROM products WHERE id = ?`, иначе
    `ApiError::not_found("no such product")`);
  - `checksum = hex(sha2::Sha256::digest(&bytes))`;
  - `INSERT … ON CONFLICT (product_id) DO UPDATE`;
  - аудит `PRODUCT_PHOTO_SET` с `target_type: Some("product")` и
    `details: json!({ "width": put.width, "height": put.height, "bytes": bytes.len() })`;
  - ревизия не берётся: фото не в ленте.

  Маршрут в `server.rs` рядом с товарами:
  `.route("/v1/office/products/{id}/photo", get(crate::routes::product_photos::get_photo).put(crate::routes::product_photos::put_photo).delete(crate::routes::product_photos::delete_photo))`.

  Предел тела. JSON-предел роутера по умолчанию — 2 МиБ (`org_logo.rs:10-12`), а 400 000 символов
  base64 укладываются в него с запасом, поэтому отдельный слой не нужен. Записать это в
  комментарии модуля.

- [ ] **Шаг 5: зелёные тесты, `cargo fmt --check`, полный `cargo … test -p markiro-host`, коммит**
      `feat(standalone): host — product EGAIS code (group 15 only), default counterparty and photo (migration 0023)`.

## Задача 3: хост — снимок смены замораживает код ЕГАИС

**Files:** Modify `host/src/shifts.rs`, `host/tests/device_shifts.rs`, `host/tests/warehouse.rs`.

- [ ] **Шаг 1: красные тесты.**
  - `device_shifts.rs`: товар группы 15 с кодом и шаблоном, покрывающим группу 15. Его создаёт
    `office_template(&admin, "box", true, json!([15]))` из `support/app.rs`; товар сделать через
    `POST /v1/office/products` с `beer()`. Смена через `plan_shift`, вход станции — как
    в соседнем тесте входа. В ответе `snapshot.product.egaisCode == "0150320000001234567"`.
  - Тот же тест: после входа офис меняет код товара. `GET /v1/device/shifts` отдаёт снимок со
    старым кодом (заморозка).
  - Товар без кода — `egaisCode: null`.
  - `warehouse.rs`: поиск короба смены такого товара (`POST /v1/device/warehouse/lookup`) отдаёт
    `product.egaisCode` старого снимка.

  Подготовку короба взять из существующего теста поиска.

- [ ] **Шаг 2: реализация.** В `snapshot` запрос товара читает и `egais_code`: кортеж
      `ProductRow` получает `Option<String>`. `ShiftSnapshotProduct { …, egais_code }`.
      Тестовый `ShiftSnapshot` внизу `shifts.rs` (`:589-610`) получает `egais_code: None`.
      `warehouse.rs` менять не нужно: он кладёт `ShiftSnapshotProduct` из снимка как есть.
      Тест это подтверждает.
- [ ] **Шаг 3: зелёные тесты, коммит**
      `feat(standalone): host — a shift's snapshot freezes the product's EGAIS code`.

## Задача 4: станция — код ЕГАИС на этикетках короба и паллеты, листе A4 и складской перепечатке

**Files:** Modify `src/floor/print/label-render.ts`, `src/floor/print/shift-render.ts`,
`src/floor/warehouse/warehouse-work.ts`; Create `test/label-egais.test.ts`; Modify
`test/floor-label-render.test.ts`, `test/warehouse-work.test.ts`.

**Interfaces:** без новых экспортов. Внутри каждого места —
`egaisCode: product.egaisCode ?? null` (у `warehouse-work.ts` — `source.product.egaisCode ?? null`).
Комментарий `label-render.ts:45` («`egaisCode` is none (no alcohol in stage 2a)») заменить на «the
EGAIS code as the shift froze it (plan ТОВ); `null` for a product without one or a snapshot of a
host before plan ТОВ».

- [ ] **Шаг 1: красные тесты** (`test/label-egais.test.ts`):

  ```ts
  import { describe, expect, it } from "vitest";
  import { boxLabelFields } from "@markiro/domain";

  import { boxLabelData, palletLabelData } from "../src/floor/print/label-render.js";
  import { sourceFields } from "../src/floor/warehouse/warehouse-work.js";
  import { workShiftFixture } from "./support/floor.js"; // the helper the label tests use today

  const EGAIS = "0150320000001234567";

  describe("the EGAIS code on the station's labels (plan ТОВ)", () => {
    it("a box label prints the code the shift froze", () => {
      const shift = workShiftFixture({ product: { chzProductGroupCode: 15, egaisCode: EGAIS } });
      const fields = boxLabelData(
        shift,
        { sscc: "146070010000000017", itemCount: 20, closedAt: "2026-10-13T08:00:00.000Z" },
        "Иванов",
      );
      expect(fields["product.egais"]).toBe(EGAIS);
    });

    it("equals the domain's fields of the cloud station for the same product", () => {
      const shift = workShiftFixture({ product: { chzProductGroupCode: 15, egaisCode: EGAIS } });
      const box = {
        sscc: "146070010000000017",
        itemCount: 20,
        closedAt: "2026-10-13T08:00:00.000Z",
      };
      const { product, counterpartyName } = shift.snapshot;
      expect(boxLabelData(shift, box, "Иванов")).toEqual(
        boxLabelFields({
          sscc: box.sscc,
          itemCount: box.itemCount,
          productName: product.name,
          productPrintName: product.printName,
          gtin14: product.gtin14,
          egaisCode: EGAIS,
          shelfLifeDays: product.shelfLifeDays,
          operatorName: "Иванов",
          counterpartyName,
          closedAt: box.closedAt,
          productionDate: shift.copy.productionDate,
          shiftNumber: shift.copy.number,
        }),
      );
    });

    it("a pallet label prints it too", () => {
      /* palletLabelData → "product.egais" === EGAIS */
    });

    it("a snapshot of a host before plan ТОВ prints an empty field", () => {
      const shift = workShiftFixture({ product: {} }); // no egaisCode key at all
      expect(
        boxLabelData(
          shift,
          { sscc: "146070010000000017", itemCount: 1, closedAt: "2026-10-13T08:00:00.000Z" },
          null,
        )["product.egais"],
      ).toBe("");
    });

    it("a warehouse reprint takes the code of the record's shift", () => {
      // sourceFields(warehouseSourceFixture({ product: { egaisCode: EGAIS } }))["product.egais"] === EGAIS
    });
  });
  ```

  Названия помощников (`workShiftFixture`, `warehouseSourceFixture`) — те, что уже есть у
  `test/floor-label-render.test.ts` и `test/warehouse-work.test.ts`. Если помощника нет, собрать
  `WorkShift` в тесте по образцу соседнего теста.

  Лист A4. В тесте `renderShiftSheet` (найти: `rtk proxy grep -ln "renderShiftSheet" apps/standalone/test`)
  перехватить `sheetRasterize` из `ShiftRenderDeps` и проверить, что в контекст листа ушёл
  `egaisCode: EGAIS`. Для этого записать аргументы `renderSheetBytes` через подмену
  `deps.sheetRasterize`: текст поля ЕГАИС попадает в растеризатор.

  **Эталон растра** (паритет с облачной станцией): ZPL стокового шаблона короба
  (`defaultBoxLabelTemplate` или как он назван в `packages/domain/src/labels/defaults.ts`) с
  полями `boxLabelData(...)`, отрисованный `renderLabel` станции, совпадает побайтно с тем же
  `renderLabel` от `boxLabelFields({... egaisCode: EGAIS})`. Тест — в `test/label-egais.test.ts`,
  через тот же поддельный холст, что тесты печати станции.

  Прогон `pnpm … exec vitest run test/label-egais.test.ts` — красный.

- [ ] **Шаг 2: реализация** — три файла по интерфейсу выше. `src/labels/sheet-render.ts:50`
      (образец предпросмотра) и `src/floor/setup/a4-test.ts:60` (тестовая печать) остаются с
      `null`, с комментарием «образец: кода ЕГАИС нет».
- [ ] **Шаг 3: зелёные тесты, полный `… --filter @markiro/standalone test`, typecheck, lint, коммит**
      `feat(standalone): station labels, the A4 sheet and the warehouse reprint print the frozen EGAIS code`.

## Задача 5: офис — «Код ЕГАИС» и «Контрагент по умолчанию» в карточке товара; подстановка в смене

**Files:** Modify `src/office/products/{ProductDialog.tsx,product-form.ts,ProductsPage.tsx}`,
`src/office/shifts/ShiftDialog.tsx` (и `shift-form.ts`, если подстановка там),
`src/i18n/ru.json`; тесты `test/product-form.test.ts`, `test/product-dialog.test.tsx`,
`test/shift-dialog.test.tsx` (имена проверить по `ls apps/standalone/test`).

**Interfaces:**

```ts
// product-form.ts
export const productFieldsSchema = z.object({
  /* …the existing fields… */
  egaisCode: egaisCodeRule, // lib/rules.ts: trimmed text up to 64, "" allowed
  defaultCounterpartyId: z.string(), // "" for none
});
export const PRODUCT_FIELDS = {
  /* … */ egaisCode: "egaisCode",
  defaultCounterpartyId: "defaultCounterpartyId",
} as const;
/** The EGAIS field shows only for ЧЗ group 15 (the cloud's `isEgaisApplicable`). */
export function showsEgais(groupCode: string): boolean; // isEgaisApplicable(toGroupCode(groupCode))
// toProductInput: egaisCode = showsEgais(group) ? toOptionalText(values.egaisCode) : null
```

`egaisCodeRule` добавить в `src/lib/rules.ts` по образцу `printNameRule`. Сообщение — ключ
`office.products.errors.egaisTooLong`.

Тексты (`src/i18n/ru.json`, ключи `office.products.*`):

| Ключ                                          | Текст                                                           |
| --------------------------------------------- | --------------------------------------------------------------- |
| `office.products.fields.egaisCode`            | «Код ЕГАИС»                                                     |
| `office.products.fields.egaisHint`            | «Печатается на этикетке короба и паллеты. Обычно 19 цифр.»      |
| `office.products.errors.egaisTooLong`         | «Код ЕГАИС — не длиннее 64 символов»                            |
| `office.products.fields.counterparty`         | «Контрагент по умолчанию»                                       |
| `office.products.fields.counterpartyNone`     | «Не выбран»                                                     |
| `office.products.fields.counterpartyHint`     | «Подставляется в смену этого товара, если контрагент не выбран» |
| `office.products.fields.counterpartyArchived` | «{{name}} (в архиве)»                                           |

Подпись «Код ЕГАИС» совпадает с облачной формой: перед записью сверить с ключом в
`apps/admin/src/i18n/ru.json`
(`rtk proxy grep -n "ЕГАИС" apps/admin/src/i18n/ru.json`). Если там другое слово — взять облачное
и записать это в «Отклонения».

- [ ] **Шаг 1: красные тесты.**
  - `product-form.test.ts`:
    - `showsEgais("15") === true`, `showsEgais("8") === false`, `showsEgais("") === false`;
    - `toProductInput` при группе 8 и введённом коде даёт `egaisCode: null` (поле спрятано, код
      не уходит);
    - при группе 15 даёт обрезанный код;
    - пустая строка даёт `null`;
    - `productFields(product)` переносит `egaisCode` и `defaultCounterpartyId`.
  - `product-dialog.test.tsx` (поддельный `HostApi`, как сегодня):
    - поле «Код ЕГАИС» есть только при выбранной группе 15;
    - смена группы с 15 на 8 прячет его и при сохранении шлёт `egaisCode: null`;
    - ошибка хоста `validation_failed` с полем `egaisCode` показывается под полем
      (`PRODUCT_FIELDS`);
    - «Контрагент по умолчанию» предлагает активных контрагентов по имени и «Не выбран»;
    - архивный контрагент, уже выбранный у товара, показан как «… (в архиве)» и не теряется
      при сохранении;
    - клавиатура: Tab доходит до обоих полей, у каждого есть `label`.
  - `shift-dialog.test.tsx`:
    - выбор товара с `defaultCounterpartyId` при пустом контрагенте подставляет его;
    - если контрагент уже выбран, не меняет его;
    - архивный не подставляет;
    - у правки активной смены поле контрагента не трогается.

  Прогон — красный.

- [ ] **Шаг 2: реализация.**
  - **Поле ЕГАИС.** `Input` с `label` «Код ЕГАИС» и подсказкой `egaisHint`, рендерится при
    `showsEgais(watch("chzProductGroupCode"))`. Значение не стирается, пока поле спрятано (можно
    вернуть группу 15), но `toProductInput` его не отправляет.
  - **Контрагент.** `Select` из `useOfficeQuery(officeKeys.counterparties, …)`. Хук списка
    контрагентов уже есть у страницы контрагентов (`src/office/counterparties/CounterpartiesPage.tsx`) —
    взять его; варианты отсортировать через `activeFirstByName`.
  - **Подстановка в `ShiftDialog.tsx`.** В обработчике смены товара (тот, что сегодня
    подставляет шаблоны и вместимости) поставить `setValue("counterpartyId", product.defaultCounterpartyId)`
    при пустом поле и активном контрагенте. Эффект для этого не нужен: правило hooks — состояние
    выводится в обработчике.
  - **Список.** `ProductsPage.tsx` получает значок «Фото» (текст, не только цвет) в строке, где
    `photoChecksum !== null`; ключ `office.products.table.hasPhoto` = «Есть фото».
- [ ] **Шаг 3: зелёные тесты (дважды, см. «Заметки»), typecheck, lint, prettier, коммит**
      `feat(standalone): office — EGAIS code for group 15 and a default counterparty on the product; the shift dialog offers it`.

## Задача 6: фото товара — загрузка в офисе и «Бланк смены»

**Files:** Create `src/office/products/{ProductPhotoField.tsx,photo-encode.ts}`,
`test/product-photo.test.tsx`; Modify `src/office/products/ProductDialog.tsx`,
`src/office/forms/{form-data.ts,task-inputs.ts}`, `src/i18n/ru.json`,
`packages/domain/src/print-forms/shift-task-form.ts`, `packages/domain/test/shift-task-form.test.ts`,
`test/print-form.test.ts`.

**Interfaces:**

```ts
// photo-encode.ts — the canvas work behind a seam, as the logo's (`org/logo-canvas.ts`)
export const PHOTO_MAX_SIDE = 640;
export const PHOTO_MAX_BYTES = 300_000;
export interface EncodedPhoto { width: number; height: number; dataBase64: string }
export type PhotoEncoder = (file: Blob) => Promise<EncodedPhoto>;
/** A picture as the JPEG the host keeps: the longer side at most 640, quality 0.85, then 0.7 and 0.5 until it fits 300 000 bytes. */
export const encodePhoto: PhotoEncoder;
export class PhotoTooLargeError extends Error {}
export class PhotoUnreadableError extends Error {}

// ProductPhotoField.tsx
export interface ProductPhotoFieldProps {
  productId: string;          // the field shows for a saved product only
  encode?: PhotoEncoder;      // tests pass a fake; default encodePhoto
}
export function ProductPhotoField(props: ProductPhotoFieldProps): JSX.Element;

// packages/domain ShiftTaskFormData
/** The photo's own source (the standalone office: a `data:` URL); left out, the cloud's relative link. */
imageSrc?: string;
```

Тексты: `office.products.photo.title` «Фото», `office.products.photo.choose` «Выбрать фото»,
`office.products.photo.replace` «Заменить», `office.products.photo.remove` «Удалить фото»,
`office.products.photo.hint` «JPEG, PNG или WebP. Фото уменьшается до 640 точек по большей
стороне и печатается на бланке смены.», `office.products.photo.unreadable` «Не удалось прочитать
картинку», `office.products.photo.tooLarge` «Картинка слишком большая даже после сжатия»,
`office.products.photo.alt` «Фото товара {{name}}», `office.products.photo.saveFirst` «Фото можно
добавить после сохранения товара».

- [ ] **Шаг 1: эталон домена — красный тест** (`packages/domain/test/shift-task-form.test.ts`):

  ```ts
  it("a photo's own source replaces the cloud's link, and leaving it out changes nothing", () => {
    const base = taskFormFixture({ imageChecksum: "abc123" }); // the file's helper
    const cloud = renderShiftTaskFormHtml(base);
    expect(cloud).toContain('src="../../products/');
    const standalone = renderShiftTaskFormHtml({
      ...base,
      imageSrc: "data:image/jpeg;base64,/9j/4AAQ",
    });
    expect(standalone).toContain('src="data:image/jpeg;base64,/9j/4AAQ"');
    expect(standalone).not.toContain("../../products/");
    // the cloud's bytes: the snapshot test of every form stays as it is
  });
  ```

  Имя рендера и помощника — как в файле теста. Снимок `test/print-forms-snapshot.test.ts` не
  меняется, и это и есть эталон побайтности для облака.

- [ ] **Шаг 2: реализация в домене.** В `shift-task-form.ts`:

  ```ts
  const photo =
    data.imageChecksum === null
      ? ""
      : `<div class="product-photo"><img src="${escapeHtml(
          data.imageSrc ?? `../../products/${data.productId}/image/${data.imageChecksum}`,
        )}" alt=""></div>`;
  ```

  Осторожно с побайтностью. Сегодня `escapeHtml` применяется к `productId` и `imageChecksum`
  отдельно, а не ко всей строке. `escapeHtml` строки `../../products/<uuid>/image/<hex>` даёт тот
  же текст, потому что в ней нет экранируемых символов. Если снимок облака всё же изменится —
  оставить прежнее выражение для ветки без `imageSrc` дословно и экранировать только `imageSrc`.
  Затем `pnpm … --filter @markiro/domain exec vitest run` (весь пакет, снимок цел) и
  `pnpm … --filter @markiro/domain build`.

- [ ] **Шаг 3: красные тесты офиса.**
  - `test/product-photo.test.tsx`, с поддельным `encode` и `HostApi`:
    - у нового товара — подсказка `saveFirst` вместо кнопки;
    - выбор файла вызывает `encode`, затем `putProductPhoto` с результатом; превью — `<img>` с
      `alt` по имени и `src` `data:image/jpeg;base64,…`;
    - «Удалить фото» вызывает `deleteProductPhoto` и показывает «Выбрать фото»;
    - `PhotoUnreadableError` и `PhotoTooLargeError` показывают свои тексты в `Alert`;
    - ошибка записи хоста — `WriteFailureAlert`;
    - кнопки достижимы с клавиатуры, у поля выбора файла есть подпись.
  - `test/print-form.test.ts`: «Бланк смены» товара с фото содержит
    `src="data:image/jpeg;base64,` и `imageChecksum` фото; без фото — блока фото нет
    (`product--no-photo`).
  - `photo-encode.ts` в jsdom не исполняется, потому что холста нет; его покрывает проверка
    владельца 5.
- [ ] **Шаг 4: реализация офиса.**
  - `ProductPhotoField` — секция в `ProductDialog` для сохранённого товара. Фото пишется сразу
    своей кнопкой, а не по «Сохранить» формы, как у логотипа (`OrgLogoCard.tsx`). Запросы — через
    `useOfficeQuery(["office","products",id,"photo"], …)` и `useOfficeMutation` с инвалидацией
    `officeKeys.products`: в списке меняется `photoChecksum`.
  - `task-inputs.ts` дочитывает фото товара смены (`getProductPhoto`); ошибка чтения фото бланк не
    останавливает, бланк печатается без фото.
  - `form-data.ts`: при наличии фото `imageChecksum: photo.checksum` и
    `imageSrc: \`data:image/jpeg;base64,${photo.dataBase64}\``. Комментарий над `taskFormData`
    («the product has no photo») обновить.
- [ ] **Шаг 5: зелёные тесты (дважды), typecheck, lint, prettier, коммит** (явные пути, включая
      `packages/domain`)
      `feat(standalone): product photo in the office and on the shift task form (domain: optional image source, cloud output unchanged)`.

## Задача 7: ИМП — код ЕГАИС и контрагент по умолчанию из облака

**Files:** Modify `tools/standalone-export/export.sql`, `tools/standalone-export/transform.mjs`,
`tools/standalone-export/test/{transform.test.mjs,export-sql.test.mjs,cli.test.mjs}`,
`tools/standalone-export/test/fixtures/{seed-cloud.sql,raw-cloud.json}`,
`apps/standalone/proto/src/cloud_import.rs`, `apps/standalone/proto/fixtures/cloud-export-file.json`,
`apps/standalone/host/src/cloud_import.rs`, `apps/standalone/host/src/routes/cloud_import.rs`,
`apps/standalone/host/tests/cloud_import.rs`, `apps/standalone/src/office/import/import-notes.ts`,
`apps/standalone/src/i18n/ru.json`, `test/cloud-import-page.test.tsx`.

- [ ] **Шаг 1: красные тесты инструмента.**
  - `export-sql.test.mjs`. Сид `seed-cloud.sql` уже несёт `egais_code` у одного товара: строка
    `:84` перечисляет столбец. Проверить, что значение не `NULL`, и при нужде дописать товар
    группы 15 с кодом и `default_counterparty_id`. Ожидание теста меняется так:
    - `lost` больше не содержит `egaisCode` и `defaultCounterparty`;
    - в объекте товара есть `"egaisCode": "<код>"` и `"defaultCounterpartyId": "<uuid>"`.

    Ожидание `:124` (`[["price"], ["externalRef"], ["egaisCode"], ["defaultCounterparty",
"photo"]]`) меняется на `[["price"], ["externalRef"], [], ["photo"]]` — или как ляжет порядок
    сида. Это смена продуктового решения ПР-6: записать в «Отклонения».

  - `transform.test.mjs`:
    - код у товара группы 15 переходит;
    - код у товара другой группы снимается с заметкой
      `{ code: "product_value_cleared", id, field: "egaisCode" }`;
    - контрагент по умолчанию переходит, если контрагент есть в файле, и снимается с заметкой
      `product_value_cleared` (поле `defaultCounterpartyId`), если контрагент отброшен;
    - `formatVersion` файла — 2;
    - сырой ввод `formatVersion` 1 (старый `export.sql`) тоже читается, и тогда поля — `null`.
  - `cli.test.mjs` сверяет файл с `proto/fixtures/cloud-export-file.json`, поэтому фикстура
    перегенерируется. Способ — тот, что описан в `apps/standalone/AGENTS.md` «Cloud import» и в
    шапке `cli.test.mjs`: найти команду перегенерации (`rtk proxy grep -n "regenerate\|UPDATE_FIXTURE\|write.*cloud-export-file" tools/standalone-export/test/*.mjs`).
    Руками фикстуру не править.

  Прогон: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false test:standalone-export` — красный.

- [ ] **Шаг 2: реализация инструмента.**

  `export.sql`, в объекте товара:

  ```sql
  'egaisCode', p.egais_code,
  'defaultCounterpartyId', p.default_counterparty_id,
  'lost', to_json(array_remove(ARRAY[
    CASE WHEN p.external_ref IS NOT NULL THEN 'externalRef' END,
    CASE WHEN EXISTS (SELECT 1 FROM product_images i
      WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id) THEN 'photo' END,
    CASE WHEN p.unit_price IS NOT NULL THEN 'price' END], NULL)))
  ```

  Плюс `'formatVersion', 2` там, где сырой документ называет версию:
  `rtk proxy grep -n "formatVersion" tools/standalone-export/export.sql`. Статический тест
  `export-sql-static.test.mjs` (только чтение и область арендатора) должен остаться зелёным.

  `transform.mjs`:
  - `raw.formatVersion` принимается `1` или `2`;
  - `FILE_FORMAT_VERSION = 2`;
  - в блоке товаров:

  ```js
  const egais = each.egaisCode ?? null;
  let egaisCode = null;
  if (egais !== null) {
    const text = plainText(egais, 64);
    if (each.chzProductGroupCode === 15 && text !== "") egaisCode = text;
    else note({ code: "product_value_cleared", id: each.id, field: "egaisCode" });
  }
  const counterpartyId = each.defaultCounterpartyId ?? null;
  const defaultCounterpartyId =
    counterpartyId !== null && keptCounterpartyIds.has(counterpartyId) ? counterpartyId : null;
  if (counterpartyId !== null && defaultCounterpartyId === null)
    note({ code: "product_value_cleared", id: each.id, field: "defaultCounterpartyId" });
  // products.push({ …, egaisCode, defaultCounterpartyId, archived: each.archived })
  ```

  `keptCounterpartyIds` — множество id контрагентов, которые блок контрагентов выше положил в
  файл; его нужно собрать там же. Число 15 — константа с комментарием-ссылкой на
  `packages/domain/src/product-attributes/egais.ts`. Инструмент от `@markiro/domain` не зависит,
  проверить по `package.json`; если зависит — импортировать `EGAIS_PRODUCT_GROUP_CODE`.

- [ ] **Шаг 3: красные тесты хоста** (`host/tests/cloud_import.rs`):
  - импорт фикстуры переносит `egais_code` и `default_counterparty_id` (`SELECT … FROM products
WHERE id = ?`);
  - файл формата 1 (фикстура с `formatVersion: 1` и без новых полей, собранная в тесте из
    `cloud-export-file.json` удалением полей) принимается, поля `NULL`;
  - формат 3 — `400` `validation_failed` `formatVersion`;
  - код ЕГАИС у товара группы 8 в файле — `400` `validation_failed` на `payload.products.N.egaisCode` (правило
    хоста то же, что в маршруте);
  - контрагент по умолчанию, которого нет среди `payload.counterparties`, — `400` `validation_failed` на
    `payload.products.N.defaultCounterpartyId`.
- [ ] **Шаг 4: реализация хоста.**
  - `CloudProduct` получает `#[serde(default)] pub egais_code: Option<String>` и
    `#[serde(default)] pub default_counterparty_id: Option<String>`;
    `CLOUD_IMPORT_FORMAT_VERSION = 2`, плюс константа `CLOUD_IMPORT_FORMAT_VERSIONS: [u32; 2] = [1, 2]`.
  - `cloud_import.rs:136` сверяет `CLOUD_IMPORT_FORMAT_VERSIONS.contains(&request.format_version)`;
    текст ошибки — «this host reads format versions 1 and 2».
  - Проверка товара — `validate::egais_code` и правило группы. Ссылку на контрагента проверить по
    множеству id контрагентов файла, собранному выше, так же как шаблоны (`scopes`).
  - `Product` и `INSERT` в `routes/cloud_import.rs:239` получают два столбца.
  - Офис: `import-notes.ts` — у заметки `product_value_cleared` поля `egaisCode` и
    `defaultCounterpartyId` получают тексты:
    - `office.import.notes.fields.egaisCode` — «код ЕГАИС»;
    - `office.import.notes.fields.defaultCounterpartyId` — «контрагент по умолчанию».

    Тексты существующих полей посмотреть рядом. `product_fields_lost` больше не приходит с
    `egaisCode` и `defaultCounterparty`, но старые файлы формата 1 их несут, поэтому тексты этих
    полей остаются.

  - Тест страницы импорта: заметка по полю `egaisCode` показывается словами.
- [ ] **Шаг 5: зелёные тесты инструмента, хоста и офиса, `cargo fmt --check`, коммит**
      `feat(standalone): cloud import format 2 — the product's EGAIS code and default counterparty move over`.

## Задача 8: документы и итоговые проверки

**Files:** Modify `apps/standalone/AGENTS.md` (разделы «Catalog and label templates», «Cloud
import», «Floor printing», «Warehouse reprint», «Shift card and printed forms», «Verification»),
`docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` (отметка в §5.5 «реализовано
планом ТОВ, коммит …»), `docs/runbooks/standalone-cloud-cutover.md` (формат файла 2), если там
упомянута версия.

- [ ] **Шаг 1:** в `AGENTS.md` записать:
  - правило группы 15;
  - заморозку кода в снимке и то, что поле снимка необязательно;
  - что образцы печатают без кода;
  - фото: JPEG ≤ 640 × 640 и 300 000 байт, не в ленте, без ревизии, хост не разбирает картинку;
  - `imageSrc` в доменном бланке;
  - формат ИМП 2 и чтение 1;
  - список ручных проверок ТОВ в «Verification».
- [ ] **Шаг 2: полный гейт** (раздел «Итоговая проверка плана»), `git diff --check`, коммит
      `docs(standalone): plan ТОВ — EGAIS code, default counterparty and product photo`.

## Итоговая проверка плана

- `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`.
- `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --workspace` —
  частями, если целиком не укладывается: `-p markiro-proto`, `-p markiro-host`, затем крейт
  оболочки после `pnpm … --filter @markiro/standalone build`.
- `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`,
  `lint`, `build`.
- `pnpm … --filter @markiro/domain test`, `typecheck`, `lint`, `build`. Затем потребители домена,
  которых касается бланк: `pnpm … --filter @markiro/api exec vitest run` по тестам печатных форм
  смены (найти `rtk proxy grep -ln "task-form" apps/api/test`) — вывод облака не изменился.
- `pnpm … test:standalone-export`.
- `prettier --check` по всем изменённым файлам, `git diff --check`.
- Отчёт отдельно перечисляет автоматические проверки и то, что не проверено вживую (раздел «Не
  проверено»).

## Проверки владельца

1. **Этикетка пива на принтере клиента** (ZPL и TSPL, 203 и 300 dpi):
   - товар группы 15 с кодом ЕГАИС, смена, закрытый короб;
   - на этикетке в строке «ЕГАИС» напечатан код целиком, не обрезан и читается;
   - то же на этикетке паллеты и на листе A4 паллеты.
2. **Перепечатка короба** из исключений и складская перепечатка короба этой смены после смены кода
   в карточке товара: печатается старый код, тот, что заморожен при открытии смены.
3. **Смена, открытая до обновления.** Станция и хост обновлены посреди смены: этикетки идущей
   смены печатаются с пустой строкой «ЕГАИС», без ошибки. Новая смена печатает код.
4. **Карточка товара на Windows 10/11 в WebView2:**
   - поле «Код ЕГАИС» появляется и исчезает при смене группы;
   - контрагент по умолчанию подставляется в новую смену;
   - всё работает с клавиатуры (Tab, Enter, Esc).
5. **Фото:**
   - загрузить JPEG, PNG и WebP с телефона (4000 × 3000, 5 МБ): фото сжато, превью видно;
   - «Бланк смены» печатается с фото на принтере A4 и в «Открыть в браузере»;
   - удалить фото — бланк без фото.
6. **Перенос из облака на копии облачной базы клиента:**
   - товары пива приходят с кодом ЕГАИС, контрагенты по умолчанию — на месте;
   - заметки офиса называют снятые поля словами;
   - файл формата 1, сделанный раньше, всё ещё принимается.

## Открытые вопросы

- **ТОВ-1 — фото из облака.** Инструмент читает только Postgres, а картинки лежат в объектном
  хранилище. По умолчанию фото загружается в офисе вручную, заметка `photo` остаётся. Если нужно
  переносить фото, нужен отдельный шаг инструмента: S3-клиент и учётные данные хранилища облака
  на машине выгрузки.
- **ТОВ-2 — несколько кодов ЕГАИС.** Облако хранит до 20 кодов с основным. По умолчанию у товара
  в автономе один код (основной). Если клиенту нужен выбор кода на смену — отдельная задача.
- **ТОВ-3 — проверка формата кода.** По умолчанию 1–64 символа, как облачное поле. Строгие
  19 цифр — по слову владельца.

## Риски

- **Стык с fb-templates** — фикстуры товара и `routes/products.rs`. Меры: шаг 0 задачи 1 и
  исполнение после слияния.
- **Доменный бланк.** Правка `shift-task-form.ts` касается облака. Мера: снимок
  `print-forms-snapshot.test.ts` и тесты печатных форм API не меняются, это проверяется в
  итоговом гейте.
- **Размер базы.** Фото до 300 000 байт на товар: тысяча товаров — до 300 МБ в файле базы и в
  каждой копии. Мера: сжатие в офисе; в «Проверках владельца» видно, сколько весит реальное фото
  после сжатия.
- **Длинный код на узкой этикетке.** Стоковый шаблон рассчитан на 19 цифр. Код до 64 символов на
  этикетке 58 × 40 может не уместиться: облачный рендер ведёт себя так же. Проверка владельца 1.

## Не проверено

- Печать на реальных принтерах, WebView2, сжатие на холсте (`photo-encode.ts` не исполняется в
  jsdom), перенос на копии облачной базы клиента.
- Приём этикетки с кодом ЕГАИС контролирующими органами — внешняя проверка.

## Отклонения при исполнении

_(заполняет исполнитель)_
