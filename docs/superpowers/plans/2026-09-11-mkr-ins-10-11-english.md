# MKR-INS-10 и MKR-INS-11: английские версии — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** выпустить английские редакции обеих каталожных инструкций, не трогая байты русских.

**Architecture:** оба браузерных спека переводятся на цикл по локалям с таблицей `COPY`, английские кадры пишутся в `mkr-ins-1X/en/`, в модули контента добавляются блоки `en:`, реестр получает английские маршруты, релиз растёт с 32 до 34 файлов.

**Tech Stack:** Playwright (`--ignore-workspace`), Vite-харнессы админки, `@markiro/legal-documents`, Astro-лендинг, LibreOffice + veraPDF.

## Global Constraints

- Ревизии и `effectiveDate` русских записей реестра НЕ меняются: добавление локали не трогает опубликованные байты.
- Идентификаторы секций и кадров английской редакции обязаны совпадать с русскими (`content-contract.test.ts`).
- EN-сводка начинается строкой `This is an informational translation. The matching Russian revision is authoritative. ` и продолжается переводом русской сводки.
- В английском тексте обязано встречаться `Markiro` и не должно встречаться `Маркиро`; в русском — наоборот.
- Термины `definition-list` не заканчиваются знаком препинания.
- Контакт поддержки в английском тексте: `If your problem is not described above, contact Markiro support: hello@v-b.tech.`
- Кадры кабинета снимаются на ширине 1280.
- Справочник групп продукции ЧЗ (`chz_product_groups.name`) существует в одном языке и отдаётся API как есть. В английских фикстурах названия групп остаются русскими, а английский текст отдельно это оговаривает.
- Перед любым браузерным прогоном: `pnpm --filter @markiro/platform-contracts build`.
- Playwright, docker и `gh` работают только с `dangerouslyDisableSandbox: true`.

---

### Task 1: Локальная парность харнесса Национального каталога

**Files:**

- Modify: `apps/admin/test/browser/national-catalog-harness.tsx`
- Modify: `tools/production-browser/tests/catalog-import.visual.spec.ts:314`

**Interfaces:**

- Produces: энтрипоинт `national-catalog-harness.html`, принимающий `?locale=ru|en` и локализующий имя пользователя и организации.

- [ ] **Step 1: Заменить блок сессии в харнессе**

В `apps/admin/test/browser/national-catalog-harness.tsx` заменить объявления `session`/`organizations` и строку `void i18n.changeLanguage(...)` на вариант из `cabinet-harness.tsx`. Порядок важен: `params` объявляется до `session`, потому что сессия теперь зависит от локали.

```tsx
const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");
const params = new URLSearchParams(window.location.search);
/**
 * The printed instruction ships both locales from this one harness, so the
 * session strings follow the requested language too: an English frame
 * carrying a Cyrillic operator in the sidebar documents a screen the
 * cabinet never shows.
 */
const harnessLocale = params.get("locale") === "en" ? "en" : "ru";

const session: SessionData = {
  session: { activeOrganizationId: "browser_org" },
  user: {
    id: "browser_manager",
    email: "manager@example.test",
    name: harnessLocale === "ru" ? "Игорь Волков" : "Igor Volkov",
  },
};
const organizations: OrganizationSummary[] = [
  { id: "browser_org", name: harnessLocale === "ru" ? "Марка Ко" : "Marka Co", slug: "marka-ko" },
];
```

Блок `authClient` остаётся как есть, но переезжает ниже объявления `organizations`. Строку `void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "ru");` заменить на:

```tsx
// Before the first paint, so the shell never flashes the default language.
void i18n.changeLanguage(harnessLocale);
```

Объявление `const initialEntry = params.get("route") ?? "/";` сохраняется.

- [ ] **Step 2: Поправить вызов в спеке**

`tools/production-browser/tests/catalog-import.visual.spec.ts`, функция `openRoute` — пока без локали, она меняется в Task 2:

```ts
async function openRoute(page: Page, route: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`);
}
```

Изменений не требует: параметр `lang` спек не передавал. Достаточно убедиться, что ни один файл его больше не шлёт.

Run: `grep -rn "lang=en" tools/production-browser apps/admin/test`
Expected: пусто.

- [ ] **Step 3: Прогон и проверка неизменности русских кадров**

```bash
pnpm --filter @markiro/platform-contracts build
cd tools/production-browser && pnpm test:catalog-import
cd ../.. && git status --short packages/legal-documents/assets
```

Expected: 10 тестов PASS; `git status` пуст — русские кадры байт-в-байт прежние. Если какой-то PNG изменился, сравнить `magick compare -metric PAE old new null:`: значение ниже 5000 — субпиксельный дрейф, откатывать через `git checkout --`.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/test/browser/national-catalog-harness.tsx
git commit -m "test(admin): localize the National Catalog harness session"
```

---

### Task 2: Английские кадры MKR-INS-11

**Files:**

- Modify: `tools/production-browser/tests/catalog-import.visual.spec.ts`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-11/en/*.png` (10 файлов)

**Interfaces:**

- Consumes: `?locale=` из Task 1; `adminI18n` из `tools/production-browser/tests/admin-i18n.ts`.
- Produces: кадры `import-unavailable`, `import-start`, `import-selection`, `import-review`, `import-review-blocked`, `import-photo`, `import-result`, `import-result-photo`, `chz-link`, `chz-refresh-error` в локали `en`.

- [ ] **Step 1: Ввести локаль и таблицу COPY**

Заменить константу `SCREENSHOT_DIR` и `screenshotPath` на вариант от локали и добавить `COPY`. Подписи полей приходят с сервера по контракту, поэтому переводятся вместе с арендаторским текстом; названия групп ЧЗ остаются русскими в обеих сборках.

```ts
import { adminI18n, type AdminLocale } from "./admin-i18n.js";

const LOCALES: readonly AdminLocale[] = ["ru", "en"];

function screenshotPath(locale: AdminLocale, name: string): string {
  return join(
    import.meta.dirname,
    `../../../packages/legal-documents/assets/instructions/mkr-ins-11/${locale}`,
    `${name}.png`,
  );
}

/**
 * Tenant-owned text, rebuilt per locale; ids, dates and counts stay shared so
 * both frames document the same values. `productGroup` is deliberately NOT
 * translated: `chz_product_groups.name` is a single-language platform
 * directory the API serves verbatim, so an English frame showing an English
 * group would document a screen the cabinet cannot render.
 */
const COPY = {
  ru: {
    product: "Молоко",
    productLong: "Молоко питьевое пастеризованное 3,2%",
    productShort: "Молоко 3,2%",
    fieldName: "Название товара",
    fieldPrintName: "Наименование для печати",
    fieldProductGroup: "Группа продукции",
    productGroup: "Молочная продукция",
  },
  en: {
    product: "Milk",
    productLong: "Pasteurised drinking milk 3.2%",
    productShort: "Milk 3.2%",
    fieldName: "Product name",
    fieldPrintName: "Print name",
    fieldProductGroup: "Product group",
    productGroup: "Молочная продукция",
  },
} as const satisfies Record<AdminLocale, Record<string, string>>;
```

- [ ] **Step 2: Собрать фикстуры функцией от локали**

Обернуть `PREVIEW_RICH`, `PREVIEW_BLOCKED`, `RESULT_RUNNING`, `LINK_CHECK_FAILED`, `CAPABILITIES_UNAVAILABLE` и `installApi` в `function fixtures(locale: AdminLocale)`, подставив `COPY[locale]` в поля `label`, `before`, `after` и в `identity.name`. Значение `itemsFixture.items[0].name` тоже переопределить на `copy.product`, иначе список выбора останется русским:

```ts
if (path.endsWith("/items")) {
  return json(route, {
    ...itemsFixture,
    items: itemsFixture.items.map((item) => ({ ...item, name: copy.product })),
    nextCursor: null,
  });
}
```

- [ ] **Step 3: Перевести селекторы на словарь**

Заменить русские литералы в `expect`/`getByRole` на `t("pages.catalog.import.<key>")`. Соответствия: «Загрузить мои товары» → `loadOwn`, «Найти по GTIN» → `loadGtins`, «Проверить выбранные товары» → `compare`, «Название вручную» → `manualName`, «Фото» → `photo`, «Открыть товар в каталоге» → `openProduct`, «Сохраняем фото…» → `waitForPhoto`, «Национальный каталог» → `title`. Для панели связи: «Связь с Честным знаком» → `pages.catalog.chz.title`, «Обновить статус» → `pages.catalog.chz.refresh`, «Последняя проверка не удалась…» → `pages.catalog.chz.checkError`, «Связанная карточка недоступна в ЧЗ.» → `pages.catalog.chz.errors.card_unavailable`.

- [ ] **Step 4: Обернуть тесты в цикл по локалям**

```ts
for (const locale of LOCALES) {
  const { t } = adminI18n(locale);
  const { installApi } = fixtures(locale);

  async function openRoute(page: Page, route: string) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}&locale=${locale}`,
    );
  }

  test(`[${locale}] the import panel explains a missing Chestny Znak connection`, async ({
    page,
  }) => {
    // ...тело прежнее, `screenshotPath(locale, "import-unavailable")`
  });
  // ...остальные девять тестов
}
```

- [ ] **Step 5: Прогон**

```bash
cd tools/production-browser && pnpm test:catalog-import
ls ../../packages/legal-documents/assets/instructions/mkr-ins-11/en | wc -l
```

Expected: 20 тестов PASS, 10 английских кадров. Русские кадры не изменились (`git status`).

- [ ] **Step 6: Просмотр**

Открыть все десять английских PNG. Проверить: боковое меню, шапка, имя пользователя и организация — на английском; таблица сравнения полей — на английском; название группы продукции — по-русски (ожидаемо, см. Global Constraints).

- [ ] **Step 7: Commit**

```bash
git add tools/production-browser/tests/catalog-import.visual.spec.ts packages/legal-documents/assets/instructions/mkr-ins-11
git commit -m "test(catalog): capture the National Catalog import frames in English"
```

---

### Task 3: Английские кадры MKR-INS-10

**Files:**

- Modify: `tools/production-browser/tests/catalog.visual.spec.ts`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-10/en/*.png` (11 файлов)

**Interfaces:**

- Produces: кадры `catalog-list`, `catalog-filters`, `candidates-plaque`, `catalog-delete`, `product-new`, `product-gtin-owner`, `product-draft-banner`, `product-active`, `product-image`, `product-defaults`, `product-archived` в локали `en`.

- [ ] **Step 1: Таблица COPY**

```ts
const COPY = {
  ru: {
    managerFirstName: "Игорь",
    managerLastName: "Волков",
    product: "Сироп «Клюква», 0.5 л",
    productPrintName: "Сироп Клюква 0.5",
    draftProduct: "Сироп «Малина», 0.5 л",
    draftProductPrintName: "Сироп Малина 0.5",
    archivedProduct: "Сироп «Груша», 0.5 л",
    archivedProductPrintName: "Сироп Груша 0.5",
    counterparty: "ООО «Ягодный дом»",
    candidateOne: "Сироп «Вишня», 0.5 л",
    candidateTwo: "Сироп «Смородина», 0.5 л",
    unit: "шт",
    priceType: "Розничная",
  },
  en: {
    managerFirstName: "Igor",
    managerLastName: "Volkov",
    product: "Cranberry syrup, 0.5 L",
    productPrintName: "Cranberry syrup 0.5",
    draftProduct: "Raspberry syrup, 0.5 L",
    draftProductPrintName: "Raspberry syrup 0.5",
    archivedProduct: "Pear syrup, 0.5 L",
    archivedProductPrintName: "Pear syrup 0.5",
    counterparty: "Berry House LLC",
    candidateOne: "Cherry syrup, 0.5 L",
    candidateTwo: "Blackcurrant syrup, 0.5 L",
    unit: "pcs",
    priceType: "Retail",
  },
} as const satisfies Record<AdminLocale, Record<string, string>>;
```

`PRODUCT_GROUPS` и поле `productGroup` продукта не переводятся — это платформенный справочник (Global Constraints).

- [ ] **Step 2: Фикстуры и `installApi` — функцией от локали**

Обернуть `PROFILE`, `PRODUCT`, `DRAFT_PRODUCT`, `ARCHIVED_PRODUCT`, `COUNTERPARTY`, `CANDIDATES` и `installApi` в `function fixtures(locale: AdminLocale)`, подставив `COPY[locale]`. Идентификаторы, ГТИН, даты, цены и вместимости не трогать.

- [ ] **Step 3: Селекторы из словаря**

Ключи выверены по словарю. Внимание на две пары-близнеца: статусы в таблице и варианты фильтра — разные ветки с одинаковым текстом, и подставлять надо ту, что соответствует роли элемента в тесте.

| Русский литерал в спеке                   | Ключ (`pages.catalog.…`)    | Английское значение         |
| ----------------------------------------- | --------------------------- | --------------------------- |
| Каталог продукции                         | `title`                     | Product catalog             |
| Активен (ячейка таблицы)                  | `status.active`             | Active                      |
| Черновик (ячейка таблицы)                 | `status.draft`              | Draft                       |
| Не используется (ячейка таблицы)          | `status.archived`           | Not in use                  |
| Черновик (вариант в выпадающем списке)    | `statusFilter.draft`        | Draft                       |
| Статус (подпись фильтра)                  | `statusFilterLabel`         | Status                      |
| Удалить (кнопка в строке)                 | `delete`                    | Delete                      |
| Удалить продукт?                          | `deleteConfirmTitle`        | Delete product?             |
| Новый продукт                             | `form.createTitle`          | New product                 |
| Основное                                  | `form.sections.basic`       | Basic                       |
| Агрегация и цена                          | `form.sections.aggregation` | Aggregation and price       |
| Фотография                                | `form.sections.image`       | Product photo               |
| Значения по умолчанию                     | `form.sections.defaults`    | Defaults                    |
| ГТИН (подпись поля карточки)              | `form.gtinLabel`            | GTIN                        |
| Вместимость короба, шт                    | `form.boxCapacityLabel`     | Box capacity, units         |
| Вместимость поддона, шт                   | `form.palletCapacityLabel`  | Pallet capacity, units      |
| Удалить фотографию                        | `form.imageRemove`          | Remove photo                |
| Не использовать                           | `form.archivedLabel`        | Do not use                  |
| Перейти в очередь                         | `candidatesPlaque.action`   | Go to the queue             |
| Черновик — заполните группу и вместимости | `form.draftBanner`          | Draft — fill in the group … |

Одна строка собирается с подстановкой и требует `t(key, params)`:

```ts
t("pages.catalog.form.gtinOwnerHint", { name: copy.counterparty });
```

`adminI18n` бросает `Missing admin i18n key`, если ключа нет, поэтому опечатка падает сразу, а не снимает не тот экран. Заголовки секций карточки — это `<h2>`, но сами `<section>` адресуются по `aria-labelledby="product-form-*"`, и эти идентификаторы от локали не зависят: вызовы `screenshotSection` менять не нужно.

- [ ] **Step 4: Цикл по локалям**

Обернуть все одиннадцать тестов, назвав их `[${locale}] …`, и передавать локаль в харнесс:

```ts
async function openHarness(page: Page, locale: AdminLocale, route: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/test/browser/production.html?route=${encodeURIComponent(route)}&locale=${locale}`,
  );
}
```

- [ ] **Step 5: Прогон и просмотр**

```bash
cd tools/production-browser && pnpm test:catalog
ls ../../packages/legal-documents/assets/instructions/mkr-ins-10/en | wc -l
```

Expected: 22 теста PASS, 11 английских кадров, русские не изменились. Открыть все одиннадцать и убедиться, что интерфейс и данные арендатора на английском.

- [ ] **Step 6: Проверить уже опубликованные EN-кадры 08/09**

`tools/production-browser/tests/production.visual.spec.ts` переводит `productGroup` в `COPY.en` на «Soft drinks», хотя справочник ЧЗ одноязычный. Открыть английские кадры `mkr-ins-08/en` и `mkr-ins-09/en` и проверить, виден ли на них английский вариант названия группы.

Expected: если видно — это находка по уже выпущенным документам. НЕ исправлять здесь: переиздание опубликованных PDF — отдельное решение владельца. Записать в отчёт PR.

- [ ] **Step 7: Commit**

```bash
git add tools/production-browser/tests/catalog.visual.spec.ts packages/legal-documents/assets/instructions/mkr-ins-10
git commit -m "test(catalog): capture the product catalog frames in English"
```

---

### Task 4: Английский контент и регистрация

**Files:**

- Modify: `packages/legal-documents/src/documents/cabinet-catalog-product.ts`
- Modify: `packages/legal-documents/src/documents/cabinet-catalog-import.ts`
- Modify: `packages/legal-documents/src/registry.ts`
- Modify: `packages/legal-documents/test/registry.test.ts`

- [ ] **Step 1: Блок `en` для MKR-INS-10**

В `cabinet-catalog-product.ts` после блока `ru` добавить `en` с той же структурой: девять секций с идентификаторами `purpose`, `list`, `create`, `activate`, `image`, `defaults`, `retire`, `external`, `troubleshooting`, те же идентификаторы кадров и тот же порядок блоков. Заголовки — `1. Purpose`, `2. Product list`, `3. A new product: basics`, `4. Reaching the active status`, `5. Photo`, `6. Default values`, `7. Retiring a product`, `8. Products from external sources`, `9. Common questions`.

Заголовок документа: `Cabinet: the product catalog and the product card`.

Сводка:

```ts
summary:
  "This is an informational translation. The matching Russian revision is authoritative. Manager's guide: adding a product to the catalog, completing its card so it reaches the active status, adding a photo, and retiring a product.",
```

Цитаты интерфейса берутся из `apps/admin/src/i18n/en.json` и оформляются английскими кавычками `“…”`. В секции `list` добавить предложение о том, что справочник групп продукции Честного знака ведётся на русском и в английском интерфейсе названия групп показываются как есть.

- [ ] **Step 2: Блок `en` для MKR-INS-11**

В `cabinet-catalog-import.ts` — те же девять идентификаторов: `purpose`, `prerequisites`, `modes`, `selection`, `review`, `photo`, `result`, `chz-link`, `troubleshooting`. Заголовок документа: `Cabinet: importing products from the National Catalog`.

```ts
summary:
  "This is an informational translation. The matching Russian revision is authoritative. Manager's guide: importing product cards from the Chestny Znak National Catalog, reviewing fields and photos before applying, and managing the product's link to its Chestny Znak card.",
```

В секции `review` заголовок левой колонки цитируется дословно из `en.json` (`pages.catalog.import.currentColumn`) — английское ограничение на бренд его не задевает. В секции `selection` повторяется оговорка про русский справочник групп.

- [ ] **Step 3: Регистрация локали**

`packages/legal-documents/src/registry.ts`:

- в `INSTRUCTION_EN_PUBLISHED` добавить `"MKR-INS-10"` и `"MKR-INS-11"`;
- в записи релиза `MKR-INS-10` заменить `routes: { ru: "/instruktsii/katalog-kartochka-tovara/" }` на

```ts
    routes: {
      ru: "/instruktsii/katalog-kartochka-tovara/",
      en: "/en/instructions/product-catalog-card/",
    },
```

- в записи `MKR-INS-11` — на

```ts
    routes: {
      ru: "/instruktsii/katalog-zagruzka-iz-nk/",
      en: "/en/instructions/national-catalog-import/",
    },
```

Ревизии и `effectiveDate` не трогать.

- [ ] **Step 4: Тесты реестра**

`packages/legal-documents/test/registry.test.ts`: заменить

```ts
expect(legalReleaseLocales("MKR-INS-10")).toEqual(["ru"]);
expect(legalReleaseLocales("MKR-INS-11")).toEqual(["ru"]);
```

на `["ru", "en"]` для обоих и поднять счётчик маршрутов:

```ts
expect(new Set(LEGAL_RELEASES.flatMap(({ routes }) => Object.values(routes))).size).toBe(30);
```

- [ ] **Step 5: Прогон**

```bash
pnpm --filter @markiro/legal-documents build
pnpm --filter @markiro/legal-documents test
```

Expected: падают только манифестные тесты (ждут 34-й артефакт). `instruction-assets` и `content-contract` зелёные — значит идентификаторы кадров и секций сошлись и контракт бренда соблюдён.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal): add the English editions of MKR-INS-10 and MKR-INS-11"
```

---

### Task 5: Страницы лендинга

**Files:**

- Create: `apps/landing/src/pages/en/instructions/product-catalog-card/index.astro`
- Create: `apps/landing/src/pages/en/instructions/national-catalog-import/index.astro`
- Modify: `apps/landing/test/legal-rendered-page.test.ts`, `apps/landing/test/rendered-page.test.ts`, `apps/landing/src/lib/seo.test.ts`

- [ ] **Step 1: Страницы**

По образцу `apps/landing/src/pages/en/instructions/inventory-closing/index.astro`: импорты `…/mkr-ins-1X/en/<id>.png?url`, карта `images`, вызов компонента. Путь до общих модулей на этом уровне вложенности — четыре сегмента вверх:

```astro
---
import importUnavailable from "@markiro/legal-documents/assets/instructions/mkr-ins-11/en/import-unavailable.png?url";
// ...остальные девять импортов

import { getLegalDocumentPage } from "../../../../content/legal-pages";
import InstructionDocument from "../../../../components/InstructionDocument.astro";

const images = {
  "import-unavailable": importUnavailable,
  // ...
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-11", "en")} images={images} />
```

Аналогично для `product-catalog-card` с одиннадцатью кадрами `mkr-ins-10/en`.

- [ ] **Step 2: Пины**

`apps/landing/test/legal-rendered-page.test.ts` — в список кодов английского реестра (вторая ветка тернарника) добавить `"MKR-INS-10"` и `"MKR-INS-11"`, затем:

```ts
const pdfCount = route === "/legal/" ? 15 : 15;
const shaCount = route === "/legal/" ? 17 : 17;
```

Поскольку обе локали сравнялись, тернарник схлопывается — заменить обе строки на:

```ts
const pdfCount = 15;
const shaCount = 17;
```

`apps/landing/test/rendered-page.test.ts` — английский хаб инструкций:

```ts
expect([...enInstructions.querySelectorAll("[data-hub-item] a[href]")]).toHaveLength(11);
```

`apps/landing/src/lib/seo.test.ts` — оба пина sitemap `68` → `70`.

- [ ] **Step 3: Прогон**

Run: `pnpm --filter @markiro/landing test`
Expected: тесты, которым нужны 33-й и 34-й артефакты, падают до Task 6; остальные зелёные. Если падает что-то ещё — разобраться здесь.

- [ ] **Step 4: Commit**

```bash
git add apps/landing/src/pages/en apps/landing/test apps/landing/src/lib/seo.test.ts
git commit -m "feat(landing): publish the English catalog instruction pages"
```

---

### Task 6: Артефакты и аттестация

**Files:**

- Modify: `apps/landing/public/legal/`, `packages/legal-documents/test/artifact-manifest.test.ts`, `apps/landing/src/lib/legal-artifacts.test.ts`, `deploy/production/*`

- [ ] **Step 1: Генерация**

```bash
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
```

Expected: «Validated 34 immutable legal artifacts»; ровно два untracked PDF и изменённый `artifacts.json`. Если изменился любой из 32 старых файлов — STOP.

- [ ] **Step 2: Verify**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: «Verified 34 immutable legal artifacts». Без `SOFFICE_BIN` команда отказывается работать.

- [ ] **Step 3: Манифестные тесты**

`packages/legal-documents/test/artifact-manifest.test.ts`:

```ts
artifacts.push(artifactEntry("MKR-INS-10", "en", "pdfa-2b"));
artifacts.push(artifactEntry("MKR-INS-11", "en", "pdfa-2b"));
```

рядом с существующими `"ru"`-строками тех же кодов; счётчики `32` → `34` и `28` → `30`; в список ожидаемых запросов добавить

```ts
      "MKR-INS-10|en|legal-pdf|https://markiro.app/d/MKR-INS-10/2026.09/01/10.09.2026",
      "MKR-INS-11|en|legal-pdf|https://markiro.app/d/MKR-INS-11/2026.09/01/11.09.2026",
```

`apps/landing/src/lib/legal-artifacts.test.ts`: `32` → `34` и `28` → `30`.

- [ ] **Step 4: Аттестация**

```bash
shasum -a 256 apps/landing/public/legal/artifacts.json
```

`deploy/production/legal-artifacts-attestation.json`: новый `releaseId` `MKR-LEGAL-2026.09-21-<дата генерации>`, новый `manifestSha256`, +2 записи в `pdfs` (порядок — сортировка по имени файла).

`deploy/production/verify-legal-artifacts.mjs`: константу `RELEASE_ID` привести к новому значению и добавить два имени в `EXPECTED_PDFS` в алфавитном порядке:

```js
  "markiro_mkr-ins-10_2026.09-01_en.pdf",
  "markiro_mkr-ins-11_2026.09-01_en.pdf",
```

**Не забыть:** `deploy/production/test/legal-artifact-attestation.test.mjs` держит собственные копии — `releaseId`, `manifestSha256`, список `releasedPdfNames` и два счётчика `28` → `30`. `deploy/production/test/edge-contract.test.mjs`: `artifacts.length` `32` → `34`.

- [ ] **Step 5: Прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
node --test deploy/production/test/*.mjs
```

Expected: всё зелёное.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal packages/legal-documents/test apps/landing/src/lib/legal-artifacts.test.ts deploy/production
git commit -m "feat(legal): publish the English catalog artifacts and attest the release"
```

---

### Task 7: Финальная верификация

- [ ] **Step 1: Общие гейты**

```bash
pnpm format:check
pnpm --filter @markiro/legal-documents lint
pnpm --filter @markiro/production-browser exec tsc -p tsconfig.json --noEmit
```

- [ ] **Step 2: Сборка лендинга и проверка хаба**

```bash
pnpm --filter @markiro/landing build
grep -c "Cabinet: the product catalog and the product card" apps/landing/dist/en/instructions/index.html
grep -c "Cabinet: importing products from the National Catalog" apps/landing/dist/en/instructions/index.html
```

Expected: по `1` на каждый.

- [ ] **Step 3: Сверка релиза**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" \
  node packages/legal-documents/dist/cli/generate-artifacts.js --out-dir apps/landing/public/legal --check
git status --short
```

Expected: «Validated 34 immutable legal artifacts», дерево чистое.

- [ ] **Step 4: Просмотр PDF**

Растеризовать обе новые английские редакции и просмотреть страницы: кадры на месте, подписи не обрезаны, таблица метаданных на первой странице заполнена.

```bash
pdftoppm -r 72 -png apps/landing/public/legal/files/markiro_mkr-ins-10_2026.09-01_en.pdf "$TMPDIR/ins10en"
pdftoppm -r 72 -png apps/landing/public/legal/files/markiro_mkr-ins-11_2026.09-01_en.pdf "$TMPDIR/ins11en"
```

- [ ] **Step 5: Отчёт линзы**

Для каждой английской цитаты в кавычках указать ключ `en.json` и кадр, на котором она видна; перечислить принятые исключения. Отдельным разделом — находка по русскому справочнику групп и, если подтвердилась на Step 6 задачи 3, находка по уже выпущенным EN-кадрам MKR-INS-08/09.
