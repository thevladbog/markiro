# MKR-INS-11 «Кабинет: загрузка товаров из Национального каталога» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпустить одиннадцатый документ серии — инструкцию менеджера по загрузке товаров из Национального каталога и связи карточки с Честным Знаком, с десятью кадрами реальных экранов, страницей лендинга и неизменяемым PDF/A.

**Architecture:** Новый визуальный спек снимает кадры импорта поверх существующего харнеса Национального каталога, переиспользуя фикстуры, уже провалидированные zod-схемами; контент пишется по снятым кадрам с линзой по `apps/admin/src/i18n/ru.json`; документ публикуется 32-м артефактом релиза.

**Tech Stack:** TypeScript (ESM), Astro, vitest, Playwright (`tools/production-browser`, `--ignore-workspace`), LibreOffice 26.2.5 + veraPDF (docker), пиненные IBM Plex.

**Spec:** `docs/superpowers/specs/2026-09-10-mkr-ins-11-catalog-import-design.md`

## Global Constraints

- Код `MKR-INS-11`, ревизия `2026.09/01`, дата вступления `2026-09-10`, маршрут `/instruktsii/katalog-zagruzka-iz-nk/`, заголовок начинается с «Кабинет: » (по нему хаб группирует документ).
- Документ выходит **только на русском**: в `INSTRUCTION_EN_PUBLISHED` код не добавлять, EN-страницу не создавать.
- Существующий 31 файл релиза остаётся байт-в-байт; добавляется ровно один PDF.
- Кадры — в `packages/legal-documents/assets/instructions/mkr-ins-11/ru/`.
- Каждая «guillemet»-цитата существует дословно в `apps/admin/src/i18n/ru.json` и видна на кадре своего шага.
- Перед браузерными спеками: `pnpm --filter @markiro/platform-contracts build` — спеки Национального каталога импортируют схемы из `dist`.
- Playwright, docker и `gh` — вне песочницы (`dangerouslyDisableSandbox: true`).
- Генерация: `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate`; байт-сверка — тот же CLI с `--check`.
- Не использовать `git stash`; перед коммитами — `pnpm format:check`.
- Если прогон заденет кадры соседних документов — отличать дрейф по `magick compare -metric PAE` (дрейф < 5000) и откатывать `git checkout --`.

---

### Task 1: Инструмент съёмки и первые кадры

**Files:**

- Create: `tools/production-browser/tests/catalog-import.visual.spec.ts`
- Create: `tools/production-browser/catalog-import.playwright.config.ts`
- Modify: `tools/production-browser/package.json`

**Interfaces:**

- Produces: скрипт `test:catalog-import`; хелперы `settle`, `screenshotFullMain`, `json`, `installApi`, `openImport`; кадры `import-unavailable`, `import-start`.

- [ ] **Step 1: Конфиг**

Создать `tools/production-browser/catalog-import.playwright.config.ts` по образцу `national-catalog.playwright.config.ts` — важно взять **тот же** vite-конфиг (`product-labels-vite.config.ts`: он расширяет `server.fs.allow`, без него харнес не поднимется) и тот же энтрипоинт:

```ts
import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const port = 61_596;

export default defineConfig({
  testDir: "./tests",
  testMatch: "catalog-import.visual.spec.ts",
  outputDir: join(import.meta.dirname, "../../.superpowers/sdd/catalog-import-browser-output"),
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
    command: `node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/product-labels-vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/test/browser/national-catalog-harness.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
```

В `tools/production-browser/package.json` добавить:

```json
"test:catalog-import": "playwright test --config catalog-import.playwright.config.ts"
```

- [ ] **Step 2: Каркас спека**

Создать `tools/production-browser/tests/catalog-import.visual.spec.ts`. Хелперы `settle`, `screenshotFullMain`, `json` скопировать из `tests/catalog.visual.spec.ts` вместе с комментариями (панель импорта — тот же `SidePanel` с анимацией входа).

Фикстуры импортировать из уже существующего общего модуля — они провалидированы схемами, поэтому форму выдумывать не нужно:

```ts
import {
  capabilitiesFixture,
  id,
  itemsFixture,
  linkFixture,
  photoFixtureBase64,
  previewFixture,
  productFixture,
  resultFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";
```

Каталог кадров:

```ts
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-11/ru",
);
```

Открытие панели (MemoryRouter не обновляет адресную строку, поэтому маршрут задаётся параметром — так же делают спеки в `national-catalog-tests/`):

```ts
async function openImport(page: Page, route = "/catalog/import") {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`);
}
```

- [ ] **Step 3: Перехват API**

За основу взять роутер из `national-catalog-tests/import.spec.ts` (строки ~33–90): он покрывает `access/me`, `profile`, `products`, `counterparties`, `pickup-orders`, `national-catalog/capabilities`, сессии импорта, `selection`, `previews`, `applies`, картинки. Добавить сценарии:

```ts
type Scenario =
  | "unavailable" // capabilities без ownCatalog и gtinLookup
  | "start" // подключение есть, список ещё не загружен
  | "selection" // список загружен
  | "review" // подготовка готова
  | "reviewBlocked" // позиция с причиной отказа
  | "result" // операция завершена
  | "resultPhoto" // операция идёт, фото ещё сохраняется
  | "link" // панель связи карточки
  | "linkError"; // ошибка обновления связи
```

Неизвестный путь пишется в `unexpected[]` и `route.abort()`; каждый тест заканчивается `expect(unexpected).toEqual([])`.

- [ ] **Step 4: Два теста**

```ts
test("the import panel explains a missing Chestny Znak connection", async ({ page }) => {
  const unexpected = await installApi(page, "unavailable");
  await openImport(page);
  await expect(page.getByText("Национальный каталог")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-unavailable"));
  expect(unexpected).toEqual([]);
});

test("the import panel offers both ways to load products", async ({ page }) => {
  const unexpected = await installApi(page, "start");
  await openImport(page);
  await expect(page.getByRole("button", { name: "Загрузить мои товары" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Найти по GTIN" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-start"));
  expect(unexpected).toEqual([]);
});
```

Точные подписи сверить с `pages.catalog.import.*` в `ru.json` (`loadOwn`, `loadGtins`, `title`) — приведённые взяты оттуда, но если строка изменилась, брать фактическую.

- [ ] **Step 5: Прогон**

```bash
pnpm --filter @markiro/platform-contracts build
cd tools/production-browser && pnpm --ignore-workspace test:catalog-import
```

Expected: два теста PASS, `unexpected` пуст. Падение на `unexpected` перечисляет недостающие эндпоинты — добавить и повторить.

- [ ] **Step 6: Посмотреть кадры** — открыть оба PNG (`Read`): на первом видно, что загрузка недоступна, на втором — оба способа.

- [ ] **Step 7: Commit** — `test(catalog): capture the National Catalog import entry frames`.

---

### Task 2: Кадры выбора, проверки и фотографии

**Files:**

- Modify: `tools/production-browser/tests/catalog-import.visual.spec.ts`

**Interfaces:**

- Consumes: хелперы и роутер из Task 1.
- Produces: `import-selection`, `import-review`, `import-review-blocked`, `import-photo`.

- [ ] **Step 1: Сценарий выбора**

`itemsFixture` уже содержит позиции с разными значениями сопоставления. Тест открывает шаг выбора (`?step=selection` или переход по кнопке — как именно, определить по `ImportPanel.tsx:99-125`, где шаг читается из query), проверяет, что видна колонка сопоставления и счётчик выбранного, снимает `import-selection`.

- [ ] **Step 2: Сценарии проверки**

`previewFixture` — готовая подготовка. Два кадра: обычная позиция (`import-review`: вкладки, две колонки сравнения, итоговая сводка) и позиция, которую применить нельзя (`import-review-blocked`: бейдж на вкладке и причина). Для второго собрать вариант превью с полем-причиной — взять из `previewFixture` и подменить нужную запись, сохранив форму (её парсит `importPrepareResponseSchema`).

- [ ] **Step 3: Кадр фотографии**

В `previewFixture` есть кандидаты фото. Снять секцию «Фото»: текущее фото, кандидат из ЧЗ, кнопки выбора. Если секция помещается отдельно — снимать её через `page.locator(...).screenshot(...)`, как сделано для секций карточки в `catalog.visual.spec.ts`; иначе — весь шаг.

- [ ] **Step 4: Прогон и просмотр**

```bash
cd tools/production-browser && pnpm --ignore-workspace test:catalog-import
```

Expected: шесть тестов PASS. Открыть новые кадры и убедиться, что состояния различимы.

- [ ] **Step 5: Commit** — `test(catalog): capture the import selection, review and photo frames`.

---

### Task 3: Кадры результата и связи с ЧЗ

**Files:**

- Modify: `tools/production-browser/tests/catalog-import.visual.spec.ts`

**Interfaces:**

- Produces: `import-result`, `import-result-photo`, `chz-link`, `chz-refresh-error`.

- [ ] **Step 1: Результат**

`resultFixture` — завершённая операция. Кадр `import-result`: статус операции, итоги по товару и фото, кнопка «Открыть товар в каталоге». Второй кадр `import-result-photo`: та же операция в состоянии «running» с фото `pending` — кнопка заблокирована и рядом стоит пояснение про сохранение фото (поведение из PR #475, ключ `pages.catalog.import.waitForPhoto`).

- [ ] **Step 2: Связь с ЧЗ**

`linkFixture` — деталь связи. Маршрут `/catalog/<id>/chz`; `productFixture` даёт карточку. Кадр `chz-link`: статус карточки ЧЗ, сведения о связи, действия. Кадр `chz-refresh-error`: ответ обновления с кодом ошибки из `chzRefreshErrorCodeSchema` — на экране появляется сообщение из `pages.catalog.chz.errors.*`.

- [ ] **Step 3: Прогон, просмотр, счёт**

```bash
cd tools/production-browser && pnpm --ignore-workspace test:catalog-import
ls packages/legal-documents/assets/instructions/mkr-ins-11/ru | wc -l
```

Expected: десять тестов PASS, десять кадров.

- [ ] **Step 4: Commit** — `test(catalog): capture the import result and Chestny Znak link frames`.

---

### Task 4: Контент документа и регистрация

**Files:**

- Create: `packages/legal-documents/src/documents/cabinet-catalog-import.ts`
- Modify: `packages/legal-documents/src/types.ts`, `src/registry.ts`, `src/cli/verify-artifacts.ts`, `test/registry.test.ts`

- [ ] **Step 1: Выписать цитаты по кадрам**

Для каждого кадра открыть PNG и найти строки в `ru.json` (`pages.catalog.import.*`, `pages.catalog.chz.*`). Собрать таблицу «кадр → строки». Цитировать только то, что видно.

- [ ] **Step 2: Модуль контента**

`export const CABINET_CATALOG_IMPORT_CONTENT = { ru: { locale: "ru", title: "Кабинет: загрузка товаров из Национального каталога", summary: …, sections: [...] } } as const satisfies LegalDocumentSource["content"];`

Девять секций с id `purpose`, `prerequisites`, `modes`, `selection`, `review`, `photo`, `result`, `chz-link`, `troubleshooting` — содержание из раздела 1 спека. Контакты: `hello@v-b.tech`. Помнить про контракт: в русском тексте не должно быть латинского «Markiro» (писать «Маркиро»), а термины definition-list не заканчиваются пунктуацией.

- [ ] **Step 3: Регистрация**

- `types.ts`: `| "MKR-INS-11"` после `"MKR-INS-10"`.
- `registry.ts`: импорт контента; `"MKR-INS-11"` в `LEGAL_DOCUMENT_CODES` и `LEGAL_DOCUMENT_KIND_BY_CODE` (значение `"instruction"`); запись релиза с ревизией `2026.09/01`, датой `2026-09-10`, маршрутом `/instruktsii/katalog-zagruzka-iz-nk/`; строка в `LEGAL_DOCUMENTS` с ключом `MKR-INS-11/2026.09/01`.
- `cli/verify-artifacts.ts`: `"MKR-INS-11"` в собственный список кодов (он намеренно независим от реестра).

- [ ] **Step 4: Тесты реестра**

`registry.test.ts`: код в перечислении релизов, в матрице `reissuedRevision` (`"MKR-INS-11": "2026.09/01"`), в фильтре исключений по датам, `findLegalRelease("MKR-INS-11").effectiveDate` → `"2026-09-10"`, счётчик маршрутов `27` → `28`, `legalReleaseLocales("MKR-INS-11")` → `["ru"]`.

- [ ] **Step 5: Прогон**

Run: `pnpm --filter @markiro/legal-documents build && pnpm --filter @markiro/legal-documents test`
Expected: падают только манифестные тесты (ждут 32-й артефакт). `instruction-assets` зелёный — значит набор image id совпал с кадрами.

- [ ] **Step 6: Commit** — `feat(legal): add MKR-INS-11 content and register the release`.

---

### Task 5: Страница лендинга

**Files:**

- Create: `apps/landing/src/pages/instruktsii/katalog-zagruzka-iz-nk/index.astro`
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/test/legal-rendered-page.test.ts`, `apps/landing/test/rendered-page.test.ts`, `apps/landing/src/lib/seo.test.ts`

- [ ] **Step 1: Описание** — в `DESCRIPTION_BY_CODE` добавить `"MKR-INS-11"` с `ru` и `en` (тип требует обе локали, даже пока EN-страницы нет).

- [ ] **Step 2: Страница** — по образцу `apps/landing/src/pages/instruktsii/katalog-kartochka-tovara/index.astro`: десять импортов `…/mkr-ins-11/ru/<id>.png?url`, карта `images`, `<InstructionDocument page={getLegalDocumentPage("MKR-INS-11", "ru")} images={images} />`.

- [ ] **Step 3: Пины** — `legal-rendered-page.test.ts`: в список кодов RU-реестра добавить `"MKR-INS-11"`, `pdfCount` ru `14` → `15`, `shaCount` ru `16` → `17` (EN не трогать). `rendered-page.test.ts`: RU-хаб `10` → `11`. `seo.test.ts`: оба пина `67` → `68`.

- [ ] **Step 4: Прогон** — `pnpm --filter @markiro/landing test`. Тесты, которым нужен 32-й артефакт, до Task 6 падают: тогда сначала выполнить Task 6 и вернуться.

- [ ] **Step 5: Commit** — `feat(landing): publish the MKR-INS-11 instruction page`.

---

### Task 6: Артефакт и аттестация

**Files:**

- Modify: `apps/landing/public/legal/`, `packages/legal-documents/test/artifact-manifest.test.ts`, `apps/landing/src/lib/legal-artifacts.test.ts`, `deploy/production/*`

- [ ] **Step 1: Генерация**

```bash
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
```

Expected: «Validated 32 immutable legal artifacts»; ровно один untracked PDF и изменённый `artifacts.json`. Если изменился любой из 31 старого файла — STOP.

- [ ] **Step 2: Verify** — `artifacts:verify` → «Verified 32 immutable legal artifacts».

- [ ] **Step 3: Манифестные тесты**

`artifact-manifest.test.ts`: добавить `MKR-INS-11` в список сентябрьских кодов (ревизия `2026.09/01`) и в ветку дат (`2026-09-10`), `artifacts.push(artifactEntry("MKR-INS-11", "ru", "pdfa-2b"))`, счётчики `31` → `32` и `27` → `28`, строку ожидаемого запроса `"MKR-INS-11|ru|legal-pdf|https://markiro.app/d/MKR-INS-11/2026.09/01/10.09.2026"`.

`apps/landing/src/lib/legal-artifacts.test.ts`: счётчики `31` → `32` и `27` → `28`.

- [ ] **Step 4: Аттестация**

`releaseId` → `MKR-LEGAL-2026.09-20-2026-09-10`, новый `manifestSha256` (`shasum -a 256 apps/landing/public/legal/artifacts.json`), +1 запись в `pdfs`, +1 имя в `EXPECTED_PDFS`. **Не забыть** собственный список `releasedPdfNames` в `deploy/production/test/legal-artifact-attestation.test.mjs` и счётчики (`27` → `28`), а также `artifacts.length` `31` → `32` в `test/edge-contract.test.mjs`.

- [ ] **Step 5: Прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
node --test deploy/production/test/*.mjs
```

Expected: всё зелёное (deploy — вне песочницы).

- [ ] **Step 6: Commit** — `feat(legal): publish the MKR-INS-11 artifact and attest the release`.

---

### Task 7: Финальная верификация

- [ ] **Step 1:** `pnpm format:check`, `pnpm --filter @markiro/legal-documents lint`.
- [ ] **Step 2:** сборка лендинга; проверить, что документ попал в группу «Кабинет» на хабе: `grep -c "Кабинет: загрузка товаров из Национального каталога" apps/landing/dist/instruktsii/index.html` → `1`.
- [ ] **Step 3:** `--check`-сверка релиза (32 файла), дерево чистое.
- [ ] **Step 4:** отчёт линзы (цитата → ключ → кадр) и список принятых исключений.
