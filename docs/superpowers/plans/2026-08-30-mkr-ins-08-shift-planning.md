# MKR-INS-08 «Смена: линия, планирование и запуск» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Опубликовать восьмую печатную инструкцию серии — как менеджер кабинета заводит производственную линию, назначает ей станции и планирует смену до статуса «Запланирована».

**Architecture:** Тот же конвейер, что у MKR-INS-05…07: кадры снимаются реальными страницами кабинета под строгим перехватом `/api/`, контент лежит отдельным модулем в `@markiro/legal-documents`, лендинг рендерит его общим компонентом, а PDF/A-2b попадает в неизменяемый манифест и доверенную аттестацию. Единственная новая инфраструктура — обобщение существующего браузерного харнесса кабинета и второй playwright-конфиг поверх него.

**Tech Stack:** pnpm + turbo; React 19 + react-router (кабинет); Playwright (кадры); `docx` 9.7.1 → LibreOffice 26.2.5 → veraPDF 1.30.2 (артефакт); Astro (лендинг); node:test (аттестация).

## Global Constraints

- Код `MKR-INS-08`, kind `instruction`, ревизия `2026.08/01`, effectiveDate `2026-08-30`, статус `active`, RU-only, маршрут `/instruktsii/smena-planirovanie/`.
- Аудитория — менеджер кабинета. Роль в моках — `manager` → `["operations.read", "operations.write"]`.
- Каждая цитата в кавычках-ёлочках обязана существовать ДОСЛОВНО в `apps/admin/src/i18n/ru.json` (ветки `pages.shifts`, `pages.lines`, `pages.devices`, `pages.dashboard`) И быть видимой на кадре, который несёт этот шаг. Если строка реальна, но лежит на соседнем экране — это говорится прозой.
- Ни один кадр не показывает состояние, которого API не может вернуть, и ни одной кнопки, которой интерфейс не рисует.
- Идентификаторы и номера на кадрах — ровно в том виде, в каком их порождает код. Номер смены: `AUG26-003` (формат из `apps/admin/src/pages/shifts/api.ts:24`; суффикс `/S` означает смену, созданную на станции).
- Перехват `/api/` строгий: неучтённый эндпоинт добавляется в `unexpected` и роняет тест, а не даёт пустой кадр. Ослаблять запрещено.
- Пиненные счётчики (измерены на main `6b6e4a81a`): маршруты 15 → 16; артефакты 19 → 20; PDF 15 → 16; `/legal/` PDF 11 → 12 и SHA 13 → 14; sitemap 62 → 64 в ДВУХ местах; edge-contract 19 → 20; аттестация 15 → 16.
- Release id аттестации: `MKR-LEGAL-2026.08-09-2026-08-30` (`…-08-…` занят текущим релизом в main).
- Ни один пиненный тест не ослабляется: точные равенства не превращаются в `>=`, счётчики только сдвигаются.

---

## File Structure

**Харнесс (Task 1).** `apps/admin/test/browser/inventory-harness.tsx` уже полностью универсален: он монтирует `appRoutes` и берёт стартовый маршрут из `?route=`. Инвентаризационного в нём — только имя файла, заголовок и запасной маршрут. Поэтому вместо копии на 70 строк модуль переименовывается в `cabinet-harness.tsx`, а `inventory.html` и новый `production.html` оба на него ссылаются. Проверено: все 18 переходов в `inventory.visual.spec.ts` передают `?route=`, значит запасной маршрут не используется ни разу и его смена ничего не ломает.

**Спека кадров (Task 1).** Новый `tools/production-browser/tests/production.visual.spec.ts` рядом с инвентаризационным, со своим конфигом и портом. В один файл они не сводятся: у них разные наборы моков и разные каталоги кадров.

**Контент (Task 2).** `packages/legal-documents/src/documents/cabinet-shift-planning.ts` — один модуль на документ, как у всех предыдущих.

---

### Task 1: Харнесс кабинета и двенадцать кадров

**Files:**
- Rename: `apps/admin/test/browser/inventory-harness.tsx` → `apps/admin/test/browser/cabinet-harness.tsx`
- Modify: `apps/admin/test/browser/inventory.html` (одна строка `src`)
- Create: `apps/admin/test/browser/production.html`
- Create: `tools/production-browser/production.playwright.config.ts`
- Create: `tools/production-browser/tests/production.visual.spec.ts`
- Modify: `tools/production-browser/package.json` (скрипт `test:production`)
- Create: `packages/legal-documents/assets/instructions/mkr-ins-08/*.png` (12 файлов)

**Interfaces:**
- Consumes: `appRoutes` из `apps/admin/src/app.tsx`; маршруты `/lines`, `/lines/new`, `/shifts`, `/shifts/new`, `/shifts/:shiftId/edit`, `/devices` (см. `apps/admin/src/app.tsx:136-180,318`).
- Produces: двенадцать PNG с идентификаторами `lines-list`, `line-form`, `line-delete-blocked`, `device-line`, `shifts-list`, `shift-product-mode`, `shift-planning`, `shift-assignment`, `shift-aggregation`, `shift-planned`, `shift-active-edit`, `shift-delete`. Ровно эти идентификаторы использует Task 2 и Task 3.

- [ ] **Step 1: Обобщить харнесс**

```bash
git mv apps/admin/test/browser/inventory-harness.tsx apps/admin/test/browser/cabinet-harness.tsx
```

В `cabinet-harness.tsx` заменить запасной маршрут и заголовок комментария:

```tsx
/**
 * Synthetic session for the cabinet browser harness: a manager-level user
 * in the "Марка Ко" organization shared by every cabinet evidence suite.
 * Capabilities themselves are NOT injected here -- `RequireCapability`
 * (apps/admin/src/access/context.tsx) reads them from `AccessProvider`,
 * which `pages/Shell.tsx` populates from `GET /api/access/me` through
 * `useAccessDocument`. Each Playwright spec mocks that endpoint with the
 * role it needs (role "manager" -> operations.read + operations.write, see
 * packages/domain/src/access/cabinet.ts's `ROLE_CAPABILITIES`).
 */
```

```tsx
const initialEntry = new URLSearchParams(window.location.search).get("route") ?? "/";
```

Остальное не трогать.

- [ ] **Step 2: Перенаправить обе страницы харнесса**

В `apps/admin/test/browser/inventory.html` заменить строку скрипта:

```html
    <script type="module" src="/test/browser/cabinet-harness.tsx"></script>
```

Создать `apps/admin/test/browser/production.html`:

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Production browser evidence</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/test/browser/cabinet-harness.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Проверить, что инвентаризационный сьют не сломан**

```bash
pnpm --dir tools/production-browser --ignore-workspace test:inventory
```

Expected: `19 passed`. Кадры MKR-INS-06/07 не должны измениться — проверить `git status --porcelain packages/legal-documents/assets` (пусто). Если какой-то кадр изменился, восстановить его (`git checkout -- packages/legal-documents/assets`) и остановиться: значит переименование задело рендер, чего быть не должно.

- [ ] **Step 4: Конфиг Playwright для производственных кадров**

Создать `tools/production-browser/production.playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const port = 61_594;

export default defineConfig({
  testDir: "./tests",
  testMatch: "production.visual.spec.ts",
  outputDir: join(import.meta.dirname, "../../.superpowers/sdd/production-browser-output"),
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

В `tools/production-browser/package.json` рядом с `test:inventory` добавить:

```json
    "test:production": "playwright test --config production.playwright.config.ts",
```

- [ ] **Step 5: Фикстуры спеки**

Создать `tools/production-browser/tests/production.visual.spec.ts`. Формы ответов взяты из реальных контрактов: `apps/admin/src/pages/shifts/api.ts` (`ShiftDto`, `LineDto`, `LinePresenceDto`, `ShiftPlanningConfigDto`), `apps/admin/src/pages/catalog/api.ts` (`ProductDto`), `apps/admin/src/pages/devices/api.ts` (`DeviceDto`, `DevicesResponse`).

```ts
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * MKR-INS-08 (printed shift-planning instruction) screenshot targets. Mock
 * shapes follow the real response contracts in
 * apps/admin/src/pages/{shifts,catalog,counterparties,labels,devices}/api.ts.
 * Same synthetic "Марка Ко" organisation as the inventory evidence suite.
 */
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-08",
);
function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, `${name}.png`);
}

/**
 * `AppShell` pins the shell to `height: 100vh; overflow: hidden` and scrolls
 * internally inside `<main>`, so a fixed 1280x800 screenshot silently crops
 * anything below the fold. Grow the viewport by `main`'s actual overflow
 * before capturing; a no-op when the page already fits. Same technique as
 * the inventory suite's `screenshotFullMain`.
 */
async function screenshotFullMain(page: Page, path: string): Promise<void> {
  const overflow = await page
    .locator("main")
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  if (overflow > 0) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.setViewportSize({ width: viewport.width, height: viewport.height + overflow });
  }
  await page.screenshot({ path, scale: "css", fullPage: true });
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const PROFILE = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
const ACCESS = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
const PICKUP_ORDERS_EMPTY = { items: [] };

const PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_PRODUCT_ID = "20000000-0000-4000-8000-000000000002";
const ARCHIVED_PRODUCT_ID = "20000000-0000-4000-8000-000000000003";
const LINE_ID = "30000000-0000-4000-8000-000000000001";
const SECOND_LINE_ID = "30000000-0000-4000-8000-000000000002";
const TEMPLATE_ID = "40000000-0000-4000-8000-000000000001";
const COUNTERPARTY_ID = "70000000-0000-4000-8000-000000000001";
const SHIFT_ID = "80000000-0000-4000-8000-000000000001";
const ACTIVE_SHIFT_ID = "80000000-0000-4000-8000-000000000002";
const STATION_ID = "90000000-0000-4000-8000-000000000001";

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
};
const DRAFT_PRODUCT = {
  ...PRODUCT,
  id: DRAFT_PRODUCT_ID,
  gtin14: "04600000000013",
  name: "Сироп «Малина», 0.5 л",
  status: "draft",
  defaultCounterpartyId: null,
  createdAt: "2026-08-24T09:40:00.000Z",
};
const ARCHIVED_PRODUCT = {
  ...PRODUCT,
  id: ARCHIVED_PRODUCT_ID,
  gtin14: "04600000000020",
  name: "Сироп «Груша», 0.5 л",
  archived: true,
  defaultCounterpartyId: null,
  createdAt: "2026-05-18T11:05:00.000Z",
};

const LINE = { id: LINE_ID, name: "Линия розлива №1", createdAt: "2026-08-01T06:00:00.000Z" };
const SECOND_LINE = {
  id: SECOND_LINE_ID,
  name: "Линия розлива №2",
  createdAt: "2026-08-14T06:00:00.000Z",
};

/**
 * `LinesPage` renders "Станции не назначены" when `assignedStations === 0`,
 * the "Онлайн · {{online}} из {{total}} станций" chip when
 * `onlineStations > 0`, and "Офлайн" otherwise
 * (apps/admin/src/pages/lines/index.tsx:129-148). All three states appear on
 * the `lines-list` frame so the document can name each one against a picture.
 */
const LINE_PRESENCE = [
  {
    lineId: LINE_ID,
    lineName: LINE.name,
    assignedStations: 3,
    onlineStations: 2,
    lastSeenAt: "2026-08-30T05:58:00.000Z",
  },
  {
    lineId: SECOND_LINE_ID,
    lineName: SECOND_LINE.name,
    assignedStations: 1,
    onlineStations: 0,
    lastSeenAt: "2026-08-29T18:20:00.000Z",
  },
];

const COUNTERPARTY = {
  id: COUNTERPARTY_ID,
  name: "ООО «Ягодный дом»",
  inn: "7736207543",
  kpp: null,
  createdAt: "2026-07-11T08:00:00.000Z",
};
const LABEL_TEMPLATE = {
  id: TEMPLATE_ID,
  name: "Короб 100×150",
  kind: "box",
  updatedAt: "2026-08-20T10:00:00.000Z",
};
const SHIFT_PLANNING_CONFIG = { defaultBoxLabelTemplateId: TEMPLATE_ID };

const PLANNED_SHIFT = {
  id: SHIFT_ID,
  number: "AUG26-003",
  status: "planned",
  mode: "aggregation",
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  lineId: LINE_ID,
  lineName: LINE.name,
  counterpartyId: COUNTERPARTY_ID,
  counterpartyName: COUNTERPARTY.name,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: TEMPLATE_ID,
  plannedQty: 4800,
  plannedDate: "2026-08-31",
  productionDate: "2026-08-31",
  boxCapacity: 12,
  palletCapacity: 48,
  palletsEnabled: true,
  createdFrom: "admin",
  openedAt: null,
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-08-30T05:40:00.000Z",
};
const ACTIVE_SHIFT = {
  ...PLANNED_SHIFT,
  id: ACTIVE_SHIFT_ID,
  number: "AUG26-002",
  status: "active",
  plannedDate: "2026-08-30",
  productionDate: "2026-08-30",
  openedAt: "2026-08-30T04:10:00.000Z",
  createdAt: "2026-08-29T14:00:00.000Z",
};

const STATION_DEVICE = {
  id: STATION_ID,
  type: "station",
  name: "Станция розлива 1",
  place: { id: LINE_ID, name: LINE.name },
  status: "online",
  lastSeenAt: "2026-08-30T05:59:00.000Z",
  paired: true,
};
const DEVICES_RESPONSE = { items: [STATION_DEVICE], page: 1, pageSize: 20, total: 1 };
```

- [ ] **Step 6: Перехват API и сценарии**

Добавить в тот же файл. Сценарии соответствуют кадрам один к одному.

```ts
type Scenario =
  | "lines"
  | "linesDeleteBlocked"
  | "devices"
  | "shiftsList"
  | "shiftCreate"
  | "shiftsPlanned"
  | "shiftActiveEdit";

/**
 * Every scenario shares the shell fetches (profile, access, pending
 * pickup-order count) and adds only what its screen needs. Anything not
 * matched aborts and is recorded in `unexpected`, so a screen that quietly
 * needs one more endpoint fails the test instead of rendering a
 * false-positive empty state.
 */
async function installApi(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/profile") return json(route, PROFILE);
    if (path === "/api/access/me") return json(route, ACCESS);
    if (path === "/api/pickup-orders") return json(route, PICKUP_ORDERS_EMPTY);

    if (scenario === "lines" || scenario === "linesDeleteBlocked") {
      if (path === "/api/lines") return json(route, { items: [LINE, SECOND_LINE] });
      if (path === "/api/lines/presence") return json(route, { items: LINE_PRESENCE });
      if (scenario === "linesDeleteBlocked" && path === `/api/lines/${LINE_ID}`) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "LINE_REFERENCED" }),
        });
      }
    }

    if (scenario === "devices" && path === "/api/devices") {
      return json(route, DEVICES_RESPONSE);
    }

    if (
      scenario === "shiftsList" ||
      scenario === "shiftCreate" ||
      scenario === "shiftsPlanned" ||
      scenario === "shiftActiveEdit"
    ) {
      if (path === "/api/shifts") {
        const items =
          scenario === "shiftsList"
            ? [ACTIVE_SHIFT]
            : scenario === "shiftActiveEdit"
              ? [ACTIVE_SHIFT]
              : [PLANNED_SHIFT, ACTIVE_SHIFT];
        return json(route, { items });
      }
      if (path === "/api/products") {
        return json(route, { items: [PRODUCT, DRAFT_PRODUCT, ARCHIVED_PRODUCT] });
      }
      if (path === "/api/lines") return json(route, { items: [LINE, SECOND_LINE] });
      if (path === "/api/counterparties") return json(route, { items: [COUNTERPARTY] });
      if (path === "/api/label-templates") return json(route, { items: [LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") return json(route, SHIFT_PLANNING_CONFIG);
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

- [ ] **Step 7: Сценарии линий и устройства**

```ts
test("lines list shows all three presence states", async ({ page }) => {
  const unexpected = await installApi(page, "lines");
  await openHarness(page, "/lines");
  await expect(page.getByText("Производственные линии")).toBeVisible();
  await expect(page.getByText("Онлайн · 2 из 3 станций")).toBeVisible();
  await expect(page.getByText("Офлайн")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("lines-list"));
  expect(unexpected).toEqual([]);
});

test("line form", async ({ page }) => {
  const unexpected = await installApi(page, "lines");
  await openHarness(page, "/lines/new");
  await expect(page.getByText("Новая линия")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("line-form"));
  expect(unexpected).toEqual([]);
});

test("deleting a referenced line is refused", async ({ page }) => {
  const unexpected = await installApi(page, "linesDeleteBlocked");
  await openHarness(page, "/lines");
  await page.getByRole("button", { name: "Удалить" }).first().click();
  await page.getByRole("button", { name: "Удалить" }).last().click();
  await expect(
    page.getByText("Линия используется в сменах или назначена одной или нескольким станциям.", {
      exact: false,
    }),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath("line-delete-blocked"));
  expect(unexpected).toEqual([]);
});

test("device carries its line", async ({ page }) => {
  const unexpected = await installApi(page, "devices");
  await openHarness(page, "/devices");
  await expect(page.getByText("Линия розлива №1")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("device-line"));
  expect(unexpected).toEqual([]);
});
```

- [ ] **Step 8: Запустить и посмотреть первые четыре кадра**

```bash
pnpm --dir tools/production-browser --ignore-workspace test:production
```

Expected: четыре теста PASS, `unexpected` пуст. ОТКРЫТЬ каждый PNG инструментом Read и убедиться, что на нём именно то, что утверждает тест. Если экран пуст или показывает состояние загрузки — это дефект, а не «так вышло»: разобраться, какого мока не хватает, по содержимому `unexpected`.

Если `lines-list` не показывает «Станции не назначены», добавить в `LINE_PRESENCE` третью линию с `assignedStations: 0` и добавить её в ответ `/api/lines` — все три состояния обязаны быть на кадре, потому что документ называет все три.

- [ ] **Step 9: Сценарии смены**

Форма смены рендерится панелью поверх списка (`ShiftPanelRoute`), поэтому кадры разделов — это одна и та же форма с прокруткой к нужному разделу. Разделы подписаны `pages.shifts.sections.*`: «Продукт и режим», «Планирование», «Назначение производства», «Шаблоны», «Агрегация».

```ts
test("shift form: product and mode", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await expect(page.getByText("Новая смена")).toBeVisible();
  await expect(page.getByText("Продукт и режим")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-product-mode"));
  expect(unexpected).toEqual([]);
});

test("shift form: planning dates", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await page.getByText("Планирование").scrollIntoViewIfNeeded();
  await expect(page.getByText("Дата производства (для отчётов)")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-planning"));
  expect(unexpected).toEqual([]);
});

test("shift form: production assignment", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await page.getByText("Назначение производства").scrollIntoViewIfNeeded();
  await expect(page.getByText("Эмитент группового кода")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-assignment"));
  expect(unexpected).toEqual([]);
});

test("shift form: templates and aggregation", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await page.getByText("Агрегация").scrollIntoViewIfNeeded();
  await expect(page.getByText("Использовать паллеты")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-aggregation"));
  expect(unexpected).toEqual([]);
});

test("shifts list before planning", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsList");
  await openHarness(page, "/shifts");
  await expect(page.getByText("Смены")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shifts-list"));
  expect(unexpected).toEqual([]);
});

test("shifts list after planning", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsPlanned");
  await openHarness(page, "/shifts");
  await expect(page.getByText("AUG26-003")).toBeVisible();
  await expect(page.getByText("Запланирована")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-planned"));
  expect(unexpected).toEqual([]);
});
```

- [ ] **Step 10: Опасные кадры — активная смена и удаление**

Диалог «Критическое изменение активной смены» показывается при сохранении изменений уже активной смены; подтверждение удаления — из строки списка. Точные условия проверить в `apps/admin/src/pages/shifts/ShiftForm.tsx` (флаг `activeEdit`) и `apps/admin/src/pages/shifts/index.tsx` (`deleteConfirm*`), и снимать ровно то состояние, которое они действительно порождают.

```ts
test("critical change of an active shift", async ({ page }) => {
  const unexpected = await installApi(page, "shiftActiveEdit");
  await openHarness(page, `/shifts/${ACTIVE_SHIFT_ID}/edit`);
  await expect(page.getByText("Изменить смену")).toBeVisible();
  // Trigger the guarded save; the exact control is whichever field the form
  // marks as critical while `status === "active"` -- verify in ShiftForm.tsx
  // and drive that one, never a control the form does not render.
  await screenshotFullMain(page, screenshotPath("shift-active-edit"));
  expect(unexpected).toEqual([]);
});

test("deleting a planned shift asks for confirmation", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsPlanned");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Удалить" }).first().click();
  await expect(page.getByText("Удалить смену?")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-delete"));
  expect(unexpected).toEqual([]);
});
```

Если диалог критического изменения не удаётся вызвать без действия, которого интерфейс не предлагает, — НЕ подделывать кадр: сообщить об этом в отчёте, а шаг документа переписать под то, что реально показывается.

- [ ] **Step 11: Снять и посмотреть все двенадцать**

```bash
pnpm --dir tools/production-browser --ignore-workspace test:production
```

Expected: 12 passed. Затем прочитать инструментом Read КАЖДЫЙ из двенадцати PNG и записать в отчёт, что на нём видно. Отдельно проверить:
- на `shift-product-mode` черновик подписан «черновик — недоступно», архивный — «не используется», и оба НЕ выбираются (`ShiftForm.tsx:281-286`: `disabled: product.archived || product.status === "draft"`);
- ни на одном кадре нет идентификатора или номера в формате, которого продукт не порождает;
- ни один кадр не обрезан по нижней границе.

- [ ] **Step 12: Коммит**

```bash
git add apps/admin/test/browser tools/production-browser packages/legal-documents/assets/instructions/mkr-ins-08
git commit -m "test(production-browser): MKR-INS-08 shift planning screenshots from a generalized cabinet harness"
```

---

### Task 2: Контент, реестр, CLI

**Files:**
- Create: `packages/legal-documents/src/documents/cabinet-shift-planning.ts`
- Modify: `packages/legal-documents/src/types.ts` (union `LegalDocumentCode`)
- Modify: `packages/legal-documents/src/registry.ts` (kind-карта, `LEGAL_DOCUMENT_CODES`, релиз, источник)
- Modify: `packages/legal-documents/src/cli/verify-artifacts.ts:39-40` (`SAFE_FILE_NAME`)
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: двенадцать идентификаторов кадров из Task 1.
- Produces: `CABINET_SHIFT_PLANNING_CONTENT` — объект вида `{ ru: { locale, title, summary, sections } } satisfies LegalDocumentSource["content"]`, по образцу `packages/legal-documents/src/documents/cabinet-inventory-close.ts`.

- [ ] **Step 1: Расширить union кодов**

`packages/legal-documents/src/types.ts:18` — заменить окончание union:

```ts
  | "MKR-INS-07"
  | "MKR-INS-08";
```

- [ ] **Step 2: Реестр**

В `packages/legal-documents/src/registry.ts`: добавить `"MKR-INS-08"` в `LEGAL_DOCUMENT_CODES` после `"MKR-INS-07"`, добавить `"MKR-INS-08": "instruction"` в kind-карту, добавить релиз после записи MKR-INS-07:

```ts
  {
    code: "MKR-INS-08",
    revision: "2026.08/01",
    effectiveDate: "2026-08-30",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/smena-planirovanie/" },
  },
```

и источник в `LEGAL_DOCUMENTS` после записи MKR-INS-07:

```ts
  { releaseKey: "MKR-INS-08/2026.08/01", content: CABINET_SHIFT_PLANNING_CONTENT },
```

с импортом рядом с соседями:

```ts
import { CABINET_SHIFT_PLANNING_CONTENT } from "./documents/cabinet-shift-planning.js";
```

- [ ] **Step 3: CLI**

`packages/legal-documents/src/cli/verify-artifacts.ts:40`:

```ts
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[12345678])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 4: Сдвинуть пиненные счётчики пакета**

`packages/legal-documents/test/registry.test.ts:64`: `.toBe(15)` → `.toBe(16)`.
В `packages/legal-documents/test/artifact-manifest.test.ts` сдвинуть числа артефактов 19 → 20 и PDF 15 → 16 и добавить MKR-INS-08 в фикстуру полного набора — найти их `grep -n "19\|15" packages/legal-documents/test/artifact-manifest.test.ts` и менять только те, которые действительно означают эти величины. Счётчик DOCX-шаблонов (4) не трогать: инструкция не добавляет шаблонов.

- [ ] **Step 5: Написать контент**

Создать `packages/legal-documents/src/documents/cabinet-shift-planning.ts` по образцу `cabinet-inventory-close.ts`: тот же импорт типа, тот же экспортируемый объект, блоки `paragraph | ordered-list | unordered-list | definition-list | step | callout`.

Заголовок: `"Кабинет: линия, планирование и запуск смены"`.

Девять секций с `id`/`heading`:

1. `purpose` «1. Назначение» — что готовит менеджер и в каком порядке; смену ОТКРЫВАЕТ оператор на станции (MKR-INS-01), ход и закрытие — в MKR-INS-09; callout `info` про демонстрационные данные (та же формулировка, что в остальных инструкциях серии).
2. `line` «2. Производственная линия» — зачем линия, создание (`line-form`), три состояния на `lines-list`, отказ при удалении (`line-delete-blocked`), лимит по подписке.
3. `stations` «3. Станции на линии» — поле «Линия» на «Устройствах» (`device-line`); линия без станций остаётся в состоянии «Станции не назначены».
4. `catalog` «4. Что нужно от каталога» — на `shift-product-mode` видно, что продукт-черновик подписан «черновик — недоступно», архивный — «не используется», и ОБА недоступны для выбора. Это отличается от инвентаризации, где архивный продукт выбирается сознательно, — не переносить сюда формулировку из MKR-INS-06.
5. `plan` «5. Планирование смены» — форма по её пяти разделам (`shift-product-mode`, `shift-planning`), автоподстановка контрагента и вместимостей из продукта, две даты и подсказка «Если не указана, этикетки и отчёты используют прежнее правило.».
6. `assignment` «6. Линия, толлинг и эмитент» (`shift-assignment`) — «Линия», «Для контрагента (толлинг)», «Эмитент группового кода» и предупреждение UI, что это не одно и то же.
7. `aggregation` «7. Агрегация» (`shift-aggregation`) — режимы «Валидация» и «Агрегация», обязательный «Шаблон этикетки короба» и ошибка «Для агрегации выберите шаблон этикетки короба», «Вместимость короба, шт», «Использовать паллеты», «Вместимость паллеты, шт».
8. `after` «8. После планирования» (`shift-planned`, `shift-active-edit`, `shift-delete`) — статус «Запланирована», что дальше делает оператор, изменение активной смены с последствиями словами UI, удаление и его необратимость.
9. `faq` «9. Частые вопросы» — definition-list + контакты, ровно теми же полями, что в MKR-INS-07.

СТОП-УСЛОВИЕ перед коммитом: для каждой строки в кавычках-ёлочках выполнить `grep -F '<строка>' apps/admin/src/i18n/ru.json` и открыть кадр, на который ссылается несущий её шаг, инструментом Read. Строка, которой нет в `ru.json`, или которой нет на кадре, из текста удаляется или переносится в прозу.

- [ ] **Step 6: Гейты пакета**

```bash
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
```

Expected: всё PASS.

- [ ] **Step 7: Коммит**

```bash
git add packages/legal-documents
git commit -m "feat(legal-documents): MKR-INS-08 shift planning instruction content"
```

---

### Task 3: Лендинг — страница и перечисления

**Files:**
- Create: `apps/landing/src/pages/instruktsii/smena-planirovanie/index.astro`
- Modify: `apps/landing/src/content/legal-pages.ts` (`DESCRIPTION_BY_CODE`)
- Modify: `apps/landing/src/lib/legal-artifacts.ts:38-39` (`SAFE_FILE_NAME`)
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts`

**Interfaces:**
- Consumes: код `MKR-INS-08`, маршрут `/instruktsii/smena-planirovanie/`, двенадцать идентификаторов кадров.
- Produces: страницу, которую рендерит общий `InstructionDocument.astro`.

- [ ] **Step 1: Страница**

Создать `apps/landing/src/pages/instruktsii/smena-planirovanie/index.astro` строго по образцу `apps/landing/src/pages/instruktsii/inventarizatsiya-zakrytie/index.astro` — те же импорты, та же форма frontmatter, тот же вызов компонента. Ключи карты `images` — двенадцать идентификаторов из Task 1; ключи с дефисом берутся в кавычки:

```astro
---
import linesList from "@markiro/legal-documents/assets/instructions/mkr-ins-08/lines-list.png?url";
import lineForm from "@markiro/legal-documents/assets/instructions/mkr-ins-08/line-form.png?url";
import lineDeleteBlocked from "@markiro/legal-documents/assets/instructions/mkr-ins-08/line-delete-blocked.png?url";
import deviceLine from "@markiro/legal-documents/assets/instructions/mkr-ins-08/device-line.png?url";
import shiftsList from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shifts-list.png?url";
import shiftProductMode from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-product-mode.png?url";
import shiftPlanning from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-planning.png?url";
import shiftAssignment from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-assignment.png?url";
import shiftAggregation from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-aggregation.png?url";
import shiftPlanned from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-planned.png?url";
import shiftActiveEdit from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-active-edit.png?url";
import shiftDelete from "@markiro/legal-documents/assets/instructions/mkr-ins-08/shift-delete.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  "lines-list": linesList,
  "line-form": lineForm,
  "line-delete-blocked": lineDeleteBlocked,
  "device-line": deviceLine,
  "shifts-list": shiftsList,
  "shift-product-mode": shiftProductMode,
  "shift-planning": shiftPlanning,
  "shift-assignment": shiftAssignment,
  "shift-aggregation": shiftAggregation,
  "shift-planned": shiftPlanned,
  "shift-active-edit": shiftActiveEdit,
  "shift-delete": shiftDelete,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-08", "ru")} images={images} />
```

- [ ] **Step 2: Описание**

В `apps/landing/src/content/legal-pages.ts` добавить после записи `"MKR-INS-07"`:

```ts
  "MKR-INS-08": {
    ru: "Печатная инструкция менеджера: производственная линия, станции на линии, планирование смены, режимы, агрегация и запуск.",
    en: "Printable manager instruction: production lines, stations on a line, shift planning, modes, aggregation, and launch.",
  },
```

- [ ] **Step 3: `SAFE_FILE_NAME` лендинга**

`apps/landing/src/lib/legal-artifacts.ts:39`:

```ts
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[12345678])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 4: Сдвинуть пиненные счётчики лендинга**

- `apps/landing/src/lib/legal-artifacts.test.ts:45` — `toHaveLength(19)` → `toHaveLength(20)`; `:46` — `pdfa-2b` `toHaveLength(15)` → `toHaveLength(16)`; `:47` — `template-docx` остаётся `4`.
- `apps/landing/test/legal-rendered-page.test.ts:172-173` — `pdfCount` для `/legal/` `11` → `12`, `shaCount` `13` → `14`; в completeness-проверке того же файла добавить `"MKR-INS-08"` в список кодов реестра.
- `apps/landing/src/lib/seo.test.ts:84` и `:144` — `toHaveLength(62)` → `toHaveLength(64)` В ОБОИХ местах (одна инструкция даёт две записи sitemap — прецедент MKR-INS-06 и 07).

Если какой-то гейт сообщит другое число — записать ФАКТИЧЕСКОЕ число в отчёт, а не подгонять.

- [ ] **Step 5: Гейты лендинга**

```bash
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
```

Expected: сьюты, читающие манифест (`legal-rendered-page.test.ts`, `rendered-page.test.ts`, `site-audit.test.ts` и completeness-случай в `legal-artifacts.test.ts`), пока КРАСНЫЕ с `assertCompleteReleaseSet: "released artifact set is incomplete or duplicated"` — PDF MKR-INS-08 появится только в Task 4. Это ожидаемое состояние. Ни один тест ослаблять нельзя; `seo.test.ts` обязан быть зелёным уже сейчас.

- [ ] **Step 6: Коммит**

```bash
git add apps/landing
git commit -m "feat(landing): MKR-INS-08 shift planning instruction page"
```

---

### Task 4: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-08_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: задачи 1–3; тулчейн `SOFFICE_BIN=/opt/homebrew/bin/soffice` (LibreOffice 26.2.5.2), `VERAPDF_CONTAINER_RUNTIME=docker` (docker-команды запускать с отключённой песочницей, таймауты до 600000 мс).
- Produces: набор из 20 артефактов (16 PDF + 4 DOCX); аттестация `MKR-LEGAL-2026.08-09-2026-08-30`.

- [ ] **Step 1: Генерация**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

- [ ] **Step 2: Гейт детерминизма**

`git status --porcelain apps/landing/public/legal` → ТОЛЬКО `M artifacts.json` и новый `A` PDF; diff манифеста — одна вставка, прежние хеши нетронуты. Иначе `git checkout -- apps/landing/public/legal` и BLOCKED с выводом `pdffonts` по одному изменившемуся файлу.

- [ ] **Step 3: Верификация и просмотр**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 20 immutable legal artifacts`. Прочитать PDF (страницы 1–5): титул «Кабинет: линия, планирование и запуск смены», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-08», двенадцать кадров с подписями, «Шаг N.», размер < 12 MiB.

- [ ] **Step 4: Аттестация**

1. `shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-08_2026.08-01_ru.pdf`
2. `deploy/production/legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-09-2026-08-30"`, `manifestSha256` → новый, запись ins-08 сразу после ins-07 (список лексикографический), фактический `sha256`.
3. `deploy/production/verify-legal-artifacts.mjs`: `RELEASE_ID` → тот же id; в `EXPECTED_PDFS` добавить `"markiro_mkr-ins-08_2026.08-01_ru.pdf"` после ins-07.
4. `deploy/production/test/legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, список PDF (+ins-08), счётчики 15 → 16 в обоих местах.
5. `deploy/production/test/edge-contract.test.mjs:941`: `artifacts.length` 19 → 20.

- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin test
pnpm format:check
```

Expected: всё PASS. В `dist`: новая страница несёт 12 `<img>` и 12 `<figcaption>`; `/legal/index.html` содержит MKR-INS-01…08.

Если `apps/admin typecheck` падает с ошибками в `apps/saas-admin`, это несобранные воркспейс-пакеты, а не регрессия: `pnpm --filter @markiro/platform-contracts build` (при необходимости также `ui` и `domain`) и повторить.

- [ ] **Step 6: Коммит**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-08 artifact and attest the new release set"
```

---

## Self-Review Notes

- **Покрытие спеки.** Разделы 1 (документ) → Task 2; раздел 2 (скриншоты) → Task 1; раздел 3 (конвейер) → Task 2 (пакет), Task 3 (лендинг), Task 4 (артефакт и аттестация); раздел 4 (тестирование) → стоп-условие в Task 2 Step 5 и просмотр кадров в Task 1 Steps 8 и 11.
- **Расхождение со спекой, исправленное здесь.** Спека в разделе 1.4 утверждала, что архивный продукт в форме смены «выбирается сознательно». Это верно для инвентаризации, но НЕ для смены: `ShiftForm.tsx:281-286` отключает и архивные, и черновики (`disabled: product.archived || product.status === "draft"`). Task 2 Step 5 предписывает правильную формулировку и явно запрещает переносить сюда текст из MKR-INS-06.
- **Расхождение со спекой, исправленное здесь.** Спека предлагала создать новый `production-harness.tsx`. Существующий харнесс уже универсален, и копия была бы дублированием 70 строк, которое ревью справедливо отвергнет. Task 1 обобщает его в `cabinet-harness.tsx` и переиспользует из обеих HTML-страниц; риск проверяется Step 3 (инвентаризационный сьют обязан остаться зелёным с неизменными кадрами).
- **Числа.** Маршруты 16; артефакты 20 (16 PDF + 4 DOCX); `/legal/` PDF 12 / SHA 14; sitemap 64 (два места); аттестация 16 PDF; edge-contract 20. Все измерены на main `6b6e4a81a`, а не взяты по памяти.
- **Идентификаторы кадров** перечислены одинаково в Task 1 (Interfaces), Task 2 Step 5 и Task 3 Step 1 — двенадцать штук, каждый используется ровно один раз.
- **Опасные места** названы явно: изменение активной смены и удаление смены описываются словами UI, а если состояние не удаётся получить честно — Task 1 Step 10 запрещает подделывать кадр и требует переписать шаг.
- **Процессное требование спеки:** финальному whole-branch ревью задаётся линза «текст ↔ скриншоты ↔ i18n» (задаётся контролёром при диспатче).
