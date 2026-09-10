# MKR-INS-10 «Кабинет: каталог продукции и карточка товара» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпустить десятый печатный документ серии — инструкцию менеджера по ведению карточки товара в каталоге продукции, с одиннадцатью скриншотами реальных экранов, страницей лендинга и неизменяемым PDF/A в релизе.

**Architecture:** Новый визуальный спек снимает кадры кабинетного каталога через существующий харнес; контент документа пишется по снятым кадрам с линзой по `apps/admin/src/i18n/ru.json`; документ регистрируется в реестре как ru-only и публикуется 27-м артефактом релиза.

**Tech Stack:** TypeScript (ESM), Astro, vitest, Playwright (`tools/production-browser`, `--ignore-workspace`), LibreOffice 26.2.5 + veraPDF (docker), пиненные IBM Plex.

**Spec:** `docs/superpowers/specs/2026-09-10-mkr-ins-10-catalog-product-design.md`

## Global Constraints

- Код документа `MKR-INS-10`, ревизия `2026.09/01`, дата вступления `2026-09-10`, маршрут `/instruktsii/katalog-kartochka-tovara/`, заголовок начинается с «Кабинет: » (хаб группирует по префиксу до двоеточия).
- Документ выходит **только на русском**: в `INSTRUCTION_EN_PUBLISHED` код не добавляется, EN-страница не создаётся.
- Существующие 26 файлов релиза (`apps/landing/public/legal/files/*`) остаются байт-в-байт; ревизии прочих документов не трогаются.
- Кадры снимаются в `packages/legal-documents/assets/instructions/mkr-ins-10/ru/` — сразу в подпапку локали.
- Каждая «guillemet»-цитата документа существует дословно в `apps/admin/src/i18n/ru.json` и видна на кадре своего шага.
- Генерация артефактов: `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate`; верификация — тот же префикс с `artifacts:verify`; байт-сверка без публикации — `node dist/cli/generate-artifacts.js --out-dir ../../apps/landing/public/legal --check` из каталога пакета.
- Не использовать `git stash`. Перед каждым коммитом — `pnpm format:check` (чинить `pnpm format`).

---

### Task 1: Инструмент съёмки и кадры списка

**Files:**

- Create: `tools/production-browser/tests/catalog.visual.spec.ts`
- Create: `tools/production-browser/catalog.playwright.config.ts`
- Modify: `tools/production-browser/package.json` (скрипт `test:catalog`)
- Modify: `tools/production-browser/tests/inventory.visual.spec.ts` (константы каталогов кадров)
- Modify: `tools/production-browser/tests/production.visual.spec.ts` (константы каталогов кадров)

**Interfaces:**

- Produces: кадры `catalog-list`, `catalog-filters`, `candidates-plaque` в `assets/instructions/mkr-ins-10/ru/`; хелперы `settle`, `screenshotFullMain`, `json`, `installApi`, `openHarness` внутри нового спека — Task 2 добавляет к ним сценарии карточки.

- [ ] **Step 1: Починить пути кадров у соседних спек**

В `inventory.visual.spec.ts` и `production.visual.spec.ts` четыре константы каталогов заканчиваются на `mkr-ins-0X`. Добавить сегмент локали:

```ts
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-08/ru",
);
```

Так же для `mkr-ins-06`, `mkr-ins-07` (в inventory-спеке, вторая — `SCREENSHOT_DIR_07`) и `mkr-ins-09` (в production-спеке, около строки 319). Кадры не перегенерировать — правится только путь.

- [ ] **Step 2: Конфиг Playwright**

Создать `tools/production-browser/catalog.playwright.config.ts` (копия production-конфига с другим портом и `testMatch`):

```ts
import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const port = 61_595;

export default defineConfig({
  testDir: "./tests",
  testMatch: "catalog.visual.spec.ts",
  outputDir: join(import.meta.dirname, "../../.superpowers/sdd/catalog-browser-output"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/vite.config.ts --host 127.0.0.1 --port ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/test/browser/production.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
```

В `tools/production-browser/package.json` добавить в `scripts`:

```json
"test:catalog": "playwright test --config catalog.playwright.config.ts"
```

- [ ] **Step 3: Каркас спека с фикстурами**

Создать `tools/production-browser/tests/catalog.visual.spec.ts`. Хелперы `settle`, `screenshotFullMain`, `json` скопировать из `production.visual.spec.ts` (строки 30–110) вместе с их комментариями — они объясняют, почему кадр иначе ловит полуоткрытую панель и мигающую каретку.

Фикстуры (обрати внимание на черновик — он ОБЯЗАН иметь пустые группу и вместимости, иначе кадр `product-draft-banner` покажет заполненную карточку со статусом «Черновик» и соврёт читателю):

```ts
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-10/ru",
);
function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, `${name}.png`);
}

const PROFILE = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
const ACCESS = {
  roles: ["admin"],
  capabilities: [
    "operations.read",
    "operations.write",
    "integrations.read",
    "integrations.write",
    "billing.read",
  ],
};
const PICKUP_ORDERS_EMPTY = { items: [] };

const PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_PRODUCT_ID = "20000000-0000-4000-8000-000000000002";
const ARCHIVED_PRODUCT_ID = "20000000-0000-4000-8000-000000000003";
const COUNTERPARTY_ID = "70000000-0000-4000-8000-000000000001";

const PRODUCT = {
  id: PRODUCT_ID,
  gtin14: "04600000000006",
  name: "Сироп «Клюква», 0.5 л",
  productGroup: "Безалкогольные напитки",
  chzProductGroupCode: 15,
  boxCapacity: 12,
  palletCapacity: 48,
  unitPrice: "189.00",
  printName: "Сироп Клюква 0.5",
  egaisCode: null,
  shelfLifeDays: 365,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: COUNTERPARTY_ID,
  createdAt: "2026-08-03T07:12:00.000Z",
  image: { checksum: "a".repeat(64), width: 512, height: 512 },
};
const DRAFT_PRODUCT = {
  ...PRODUCT,
  id: DRAFT_PRODUCT_ID,
  gtin14: "04600000000013",
  name: "Сироп «Малина», 0.5 л",
  printName: "Сироп Малина 0.5",
  chzProductGroupCode: null,
  productGroup: null,
  boxCapacity: null,
  palletCapacity: null,
  status: "draft",
  defaultCounterpartyId: null,
  image: null,
  createdAt: "2026-08-24T09:40:00.000Z",
};
const ARCHIVED_PRODUCT = {
  ...PRODUCT,
  id: ARCHIVED_PRODUCT_ID,
  gtin14: "04600000000020",
  name: "Сироп «Груша», 0.5 л",
  printName: "Сироп Груша 0.5",
  archived: true,
  defaultCounterpartyId: null,
  image: null,
  createdAt: "2026-05-18T11:05:00.000Z",
};

const COUNTERPARTY = { id: COUNTERPARTY_ID, name: "ООО «Ягодный дом»", inn: "7701234567" };
const PRODUCT_GROUPS = {
  items: [
    { code: 15, name: "Безалкогольные напитки" },
    { code: 3, name: "Молочная продукция" },
  ],
};
const CANDIDATES = { items: [{ id: "c1" }, { id: "c2" }], total: 2 };

// Бинарь для GET /api/products/:id/image/:checksum. Значение взять из
// `apps/admin/test/national-catalog-fixtures.ts` (`photoFixtureBase64`).
const PRODUCT_IMAGE_BYTES = Buffer.from(PHOTO_FIXTURE_BASE64, "base64");
```

Формы `image`, `PRODUCT_GROUPS`, `CANDIDATES` и `COUNTERPARTY` сверить с реальными DTO (`apps/admin/src/pages/catalog/api.ts`, `pages/integrations/api.ts`) — клиент не перепарсивает ответы зодом, поэтому неверная форма даёт пустую ячейку вместо ошибки.

- [ ] **Step 4: Перехват API**

```ts
type Scenario = "list" | "listWithPlaque" | "productActive" | "productDraft" | "productNew";

async function installApi(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/profile") return json(route, PROFILE);
    if (path === "/api/access/me") return json(route, ACCESS);
    if (path === "/api/pickup-orders") return json(route, PICKUP_ORDERS_EMPTY);
    if (path === "/api/billing/attention") return json(route, { count: 0 });

    if (path === "/api/products") {
      return json(route, { items: [PRODUCT, DRAFT_PRODUCT, ARCHIVED_PRODUCT] });
    }
    if (path === "/api/counterparties") return json(route, { items: [COUNTERPARTY] });
    if (path === "/api/chz-product-groups") return json(route, PRODUCT_GROUPS);
    if (path === "/api/integration-candidates") {
      return json(route, scenario === "listWithPlaque" ? CANDIDATES : { items: [], total: 0 });
    }
    if (path === `/api/products/${PRODUCT_ID}`) return json(route, PRODUCT);
    if (path === `/api/products/${DRAFT_PRODUCT_ID}`) return json(route, DRAFT_PRODUCT);
    if (path.startsWith(`/api/products/${PRODUCT_ID}/image/`)) {
      return route.fulfill({ status: 200, contentType: "image/webp", body: PRODUCT_IMAGE_BYTES });
    }

    unexpected.push(`${route.request().method()} ${path}${url.search}`);
    return route.abort();
  });
  return unexpected;
}

async function openHarness(page: Page, route: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/production.html?route=${encodeURIComponent(route)}`);
}
```

`PRODUCT_IMAGE_BYTES` — `Buffer.from(<base64>, "base64")`; взять готовую константу `photoFixtureBase64` из `apps/admin/test/national-catalog-fixtures.ts` (импортировать по относительному пути, как это делают спеки `national-catalog-tests/`) либо скопировать значение.

- [ ] **Step 5: Три теста списка**

```ts
test("catalog list shows all three Markiro statuses", async ({ page }) => {
  const unexpected = await installApi(page, "list");
  await openHarness(page, "/catalog");
  await expect(page.getByRole("heading", { name: "Каталог продукции" })).toBeVisible();
  await expect(page.getByText("Активен")).toBeVisible();
  await expect(page.getByText("Черновик")).toBeVisible();
  await expect(page.getByText("Не используется")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("catalog-list"));
  expect(unexpected).toEqual([]);
});

test("catalog filters narrow the list by status", async ({ page }) => {
  const unexpected = await installApi(page, "list");
  await openHarness(page, "/catalog");
  await page.getByLabel("Статус").first().click();
  await screenshotFullMain(page, screenshotPath("catalog-filters"));
  expect(unexpected).toEqual([]);
});

test("unmatched 1C products surface as a plaque above the list", async ({ page }) => {
  const unexpected = await installApi(page, "listWithPlaque");
  await openHarness(page, "/catalog");
  await expect(page.getByRole("link", { name: "Перейти в очередь" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("candidates-plaque"));
  expect(unexpected).toEqual([]);
});
```

Селекторы и точные подписи выверить по `apps/admin/src/pages/catalog/index.tsx` и `ru.json` — приведённые взяты из ключей `pages.catalog.title`, `pages.catalog.status.*`, `pages.catalog.candidatesPlaque.action`; если реальный контрол фильтра рендерится иначе, поправить по факту, а не подгонять текст документа.

- [ ] **Step 6: Прогнать и вычистить `unexpected`**

Run: `pnpm --dir tools/production-browser --ignore-workspace test:catalog`
Expected: три теста PASS. Если тест падает на `expect(unexpected).toEqual([])` — в списке видны недостающие эндпоинты; добавить их моки (это и есть механизм уточнения набора из спека) и повторить.

- [ ] **Step 7: Проверить кадры глазами**

Прочитать три PNG (`Read`) и убедиться: три статуса видны, у активного товара есть фото, плашка 1С на своём кадре, панели не полуоткрыты.

- [ ] **Step 8: Commit**

```bash
git add tools/production-browser packages/legal-documents/assets/instructions/mkr-ins-10
git commit -m "test(catalog): capture the catalog list frames for MKR-INS-10"
```

---

### Task 2: Кадры карточки товара

**Files:**

- Modify: `tools/production-browser/tests/catalog.visual.spec.ts`

**Interfaces:**

- Consumes: хелперы и фикстуры из Task 1.
- Produces: восемь кадров — `product-new`, `product-gtin-owner`, `product-draft-banner`, `product-active`, `product-image`, `product-defaults`, `product-archived`, `catalog-delete`.

- [ ] **Step 1: Добавить моки карточки**

В `installApi` добавить ветки: `POST /api/products/gtin-check` (три ответа — свой ГТИН, чужой владелец, неизвестный владелец; форму сверить с `pages/catalog/api.ts`) и `GET /api/products/:id` для черновика. Точную форму ответа `gtin-check` прочитать в клиенте перед написанием мока.

- [ ] **Step 2: Тесты карточки**

Каждый тест устроен одинаково — вот полный образец, остальные отличаются сценарием, маршрутом, проверкой и именем кадра:

```ts
test("a draft card explains what is missing", async ({ page }) => {
  const unexpected = await installApi(page, "productDraft");
  await openHarness(page, `/catalog/${DRAFT_PRODUCT_ID}/edit`);
  await expect(
    page.getByText("Черновик — заполните группу и вместимости, чтобы запускать смены"),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath("product-draft-banner"));
  expect(unexpected).toEqual([]);
});
```

Маршруты и проверки остальных семи кадров:

| Кадр                 | Маршрут                               | Что проверить перед съёмкой                                                            |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `product-new`        | `/catalog/new`                        | видна секция «Основное» и поле «ГТИН»                                                  |
| `product-gtin-owner` | `/catalog/new`                        | ввести ГТИН, дождаться подсказки «Владелец ГТИН — …» и кнопки «Подставить контрагента» |
| `product-active`     | `/catalog/<PRODUCT_ID>/edit`          | видна секция «Агрегация и цена» с заполненными вместимостями                           |
| `product-image`      | `/catalog/<PRODUCT_ID>/edit`          | видна секция «Фотография» с превью (прокрутить к ней)                                  |
| `product-defaults`   | `/catalog/<PRODUCT_ID>/edit`          | видна секция «Значения по умолчанию» с контрагентом                                    |
| `product-archived`   | `/catalog/<ARCHIVED_PRODUCT_ID>/edit` | видна галочка «Не использовать» с подсказкой                                           |
| `catalog-delete`     | `/catalog`                            | нажать «Удалить» в строке, дождаться диалога подтверждения                             |

Если секции карточки не помещаются в один кадр — `screenshotFullMain` уже растит вьюпорт по фактическому переполнению; отдельные кадры на секцию нужны именно потому, что документ разбирает их по шагам.

- [ ] **Step 3: Прогнать весь спек**

Run: `pnpm --dir tools/production-browser --ignore-workspace test:catalog`
Expected: одиннадцать тестов PASS, `unexpected` пуст во всех.

- [ ] **Step 4: Пересчитать и просмотреть кадры**

```bash
ls packages/legal-documents/assets/instructions/mkr-ins-10/ru | wc -l
```

Expected: `11`. Прочитать каждый кадр и записать для отчёта линзы, какие строки на нём видны.

- [ ] **Step 5: Commit**

```bash
git add tools/production-browser packages/legal-documents/assets/instructions/mkr-ins-10
git commit -m "test(catalog): capture the product card frames for MKR-INS-10"
```

---

### Task 3: Контент документа и регистрация

**Files:**

- Create: `packages/legal-documents/src/documents/cabinet-catalog-product.ts`
- Modify: `packages/legal-documents/src/types.ts` (union `LegalDocumentCode`)
- Modify: `packages/legal-documents/src/registry.ts` (импорт, `LEGAL_DOCUMENT_CODES`, `LEGAL_DOCUMENT_KIND_BY_CODE`, `LEGAL_RELEASES`, `LEGAL_DOCUMENTS`)
- Modify: `packages/legal-documents/src/cli/verify-artifacts.ts` (собственный список кодов)
- Modify: `packages/legal-documents/test/registry.test.ts`

**Interfaces:**

- Consumes: одиннадцать кадров из Task 2 (их image id — имена файлов без `.png`).
- Produces: `CABINET_CATALOG_PRODUCT_CONTENT`, релиз `MKR-INS-10/2026.09/01`.

- [ ] **Step 1: Выписать цитаты по кадрам**

Для каждого кадра открыть PNG и параллельно найти строки в `apps/admin/src/i18n/ru.json` (группа `pages.catalog.*`). Собрать таблицу «кадр → строки, которые документ будет цитировать». Строку, которой нет на кадре, цитировать нельзя.

- [ ] **Step 2: Написать модуль контента**

Создать `packages/legal-documents/src/documents/cabinet-catalog-product.ts` по образцу `cabinet-shift-planning.ts`: `export const CABINET_CATALOG_PRODUCT_CONTENT = { ru: { locale: "ru", title: "Кабинет: каталог продукции и карточка товара", summary: …, sections: [...] } } as const satisfies LegalDocumentSource["content"];`

Девять секций с id `purpose`, `list`, `create`, `activate`, `image`, `defaults`, `retire`, `external`, `troubleshooting` — структура и содержание из раздела 1 спека. Каждый шаг с кадром — блок `kind: "step"` с `image: { id: "<имя файла>", caption: … }`; у шагов, где есть проверяемый итог, — `expected`. Контакты в последнем абзаце: `hello@v-b.tech`.

- [ ] **Step 3: Расширить union кодов**

В `packages/legal-documents/src/types.ts` добавить строку `| "MKR-INS-10"` после `"MKR-INS-09"`.

- [ ] **Step 4: Зарегистрировать релиз**

В `packages/legal-documents/src/registry.ts`:

```ts
import { CABINET_CATALOG_PRODUCT_CONTENT } from "./documents/cabinet-catalog-product.js";
```

в `LEGAL_DOCUMENT_CODES` — `"MKR-INS-10",`; в `LEGAL_DOCUMENT_KIND_BY_CODE` — `"MKR-INS-10": "instruction",`; в `LEGAL_RELEASES` последней записью:

```ts
  {
    code: "MKR-INS-10",
    revision: "2026.09/01",
    effectiveDate: "2026-09-10",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/katalog-kartochka-tovara/" },
  },
```

в `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-10/2026.09/01", content: CABINET_CATALOG_PRODUCT_CONTENT },
```

- [ ] **Step 5: Расширить список кодов в верификаторе**

В `packages/legal-documents/src/cli/verify-artifacts.ts` в собственный массив кодов (около строки 38) добавить `"MKR-INS-10",`. Этот список намеренно не импортируется из реестра — верификатор проверяет релиз независимо, поэтому правится вручную.

- [ ] **Step 6: Обновить тесты реестра**

В `packages/legal-documents/test/registry.test.ts`: добавить `"MKR-INS-10"` в перечисление кодов и в матрицу ревизий (`"MKR-INS-10": "2026.09/01"`), при необходимости — в фильтры исключений; ожидание `legalReleaseLocales("MKR-INS-10")` → `["ru"]`; счётчик уникальных маршрутов `22` → `23`; `findLegalRelease("MKR-INS-10").effectiveDate` → `"2026-09-10"`.

- [ ] **Step 7: Прогнать тесты пакета**

Run: `pnpm --filter @markiro/legal-documents build && pnpm --filter @markiro/legal-documents test`
Expected: сборка чистая; падают только манифестные тесты, которым нужен ещё не сгенерированный 27-й артефакт (они чинятся в Task 5). Тесты `instruction-assets`, `content-contract`, `registry` — зелёные. Если падает `instruction-assets` — набор image id в контенте разошёлся с файлами кадров.

- [ ] **Step 8: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal): add MKR-INS-10 content and register the release"
```

---

### Task 4: Страница лендинга

**Files:**

- Create: `apps/landing/src/pages/instruktsii/katalog-kartochka-tovara/index.astro`
- Modify: `apps/landing/src/content/legal-pages.ts` (`DESCRIPTION_BY_CODE`)
- Modify: `apps/landing/test/legal-rendered-page.test.ts`
- Modify: `apps/landing/src/lib/seo.test.ts`

- [ ] **Step 1: Описание документа**

В `apps/landing/src/content/legal-pages.ts` в `DESCRIPTION_BY_CODE` добавить запись `"MKR-INS-10"` с ключами `ru` и `en` (тип `Record<LegalDocumentCode, Record<LegalLocale, string>>` требует обе локали, даже пока публикуется только русская).

- [ ] **Step 2: Страница**

Создать страницу по образцу `apps/landing/src/pages/instruktsii/smena-zakrytie/index.astro`: одиннадцать импортов вида

```astro
import catalogList from "@markiro/legal-documents/assets/instructions/mkr-ins-10/ru/catalog-list.png?url";
```

карта `images` со всеми id и

```astro
<InstructionDocument page={getLegalDocumentPage("MKR-INS-10", "ru")} images={images} />
```

- [ ] **Step 3: Обновить пины лендинга**

В `apps/landing/test/legal-rendered-page.test.ts`: в список кодов RU-реестра добавить `"MKR-INS-10"`; `pdfCount` для `/legal/` — `13` → `14`, `shaCount` — `15` → `16` (EN-значения не трогать). В `apps/landing/src/lib/seo.test.ts` — оба пина `<url>`: `62` → `63`.

- [ ] **Step 4: Тесты и сборка лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing build`
Expected: тесты PASS (включая аудит по реальной Astro-сборке), сборка успешна. Тесты, требующие 27-го артефакта, до Task 5 могут падать — тогда сначала выполнить Task 5 и вернуться к прогону.

- [ ] **Step 5: Commit**

```bash
git add apps/landing
git commit -m "feat(landing): publish the MKR-INS-10 instruction page"
```

---

### Task 5: Артефакт и аттестация

**Files:**

- Modify: `apps/landing/public/legal/` (новый PDF + `artifacts.json`)
- Modify: `packages/legal-documents/test/artifact-manifest.test.ts`
- Modify: `apps/landing/src/lib/legal-artifacts.test.ts`
- Modify: `deploy/production/legal-artifacts-attestation.json`
- Modify: `deploy/production/verify-legal-artifacts.mjs`
- Modify: `deploy/production/test/legal-artifact-attestation.test.mjs`
- Modify: `deploy/production/test/edge-contract.test.mjs`

- [ ] **Step 1: Сгенерировать релиз**

```bash
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
```

Expected: «Validated 27 immutable legal artifacts»; в git-статусе ровно один untracked PDF (`markiro_mkr-ins-10_2026.09-01_ru.pdf`) и изменённый `artifacts.json`. Если хоть один из 26 старых файлов оказался modified — STOP: изменились чужие байты, разбираться.

- [ ] **Step 2: Верификация**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: «Verified 27 immutable legal artifacts».

- [ ] **Step 3: Манифестные тесты**

В `packages/legal-documents/test/artifact-manifest.test.ts`: в `artifactEntry` добавить `MKR-INS-10` в перечисление сентябрьских кодов (ревизия `2026.09/01`) и в ветку дат (`2026-09-10` — это новая дата, её нужно добавить и в набор ожидаемых `effectiveDate`); в `validArtifacts()` — `artifacts.push(artifactEntry("MKR-INS-10", "ru", "pdfa-2b"));`; счётчики `26` → `27` и `22` → `23`; в список ожидаемых запросов — строку `"MKR-INS-10|ru|legal-pdf|https://markiro.app/d/MKR-INS-10/2026.09/01/10.09.2026"`.

В `apps/landing/src/lib/legal-artifacts.test.ts` — счётчики `26` → `27` и `22` → `23`.

- [ ] **Step 4: Аттестация**

Обновить `deploy/production/legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.09-17-2026-09-10"`, `manifestSha256` → `shasum -a 256 apps/landing/public/legal/artifacts.json`, в `pdfs` — новая запись `{fileName, sha256}` из манифеста, порядок сортированный по имени. Те же правки: `RELEASE_ID` и `EXPECTED_PDFS` в `deploy/production/verify-legal-artifacts.mjs`; `releaseId`, `manifestSha256`, список файлов и счётчики `22` → `23` в `deploy/production/test/legal-artifact-attestation.test.mjs`; `artifacts.length` `26` → `27` в `deploy/production/test/edge-contract.test.mjs`.

- [ ] **Step 5: Прогнать deploy-контракты**

Run: `pnpm test:production-bundle:contract`
Expected: все тесты PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal packages/legal-documents/test apps/landing/src/lib deploy/production
git commit -m "feat(legal): publish the MKR-INS-10 artifact and attest the new release set"
```

---

### Task 6: Финальная верификация

- [ ] **Step 1: Формат и линт**

```bash
pnpm format:check
pnpm --filter @markiro/legal-documents lint
```

- [ ] **Step 2: Полные прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
pnpm test:production-bundle:contract
```

Expected: всё зелёное.

- [ ] **Step 3: Байт-сверка релиза**

```bash
cd packages/legal-documents && SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" node dist/cli/generate-artifacts.js --out-dir ../../apps/landing/public/legal --check
```

Expected: «Validated 27 immutable legal artifacts», рабочее дерево чистое.

- [ ] **Step 4: Проверить автоматическую регистрацию на хабе**

Хаб `/instruktsii/` собирает документы из реестра сам, но группирует по префиксу заголовка до двоеточия — проверить, что новый документ встал в существующую группу «Кабинет», а не создал десятую.

```bash
grep -c "Кабинет: каталог продукции и карточка товара" apps/landing/dist/instruktsii/index.html
```

Expected: `1` (сборка лендинга из Task 4 уже лежит в `dist`; если её нет — пересобрать `pnpm --filter @markiro/landing build`).

- [ ] **Step 5: Отчёт линзы**

Собрать для PR таблицу «цитата → ключ в `ru.json` → кадр, на котором она видна» и список принятых исключений (параметризованные шаблоны, составные подписи).
