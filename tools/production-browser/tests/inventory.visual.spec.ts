import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Mock shapes below follow the real response contracts in
 * apps/admin/src/pages/inventory/{api,schemas}.ts (parsed client-side with
 * `zod`'s `strictObject`, so every required field must be present and no
 * extra ones added) plus the sibling domains the preparation screens read
 * from (products, lines, label templates, shift planning, line presence,
 * pickup orders) via apps/admin/src/pages/{catalog,shifts,pickup}/api.ts.
 */

/**
 * MKR-INS-06 (printed inventory-preparation instruction) screenshot targets.
 * Resolved from `import.meta.dirname` rather than cwd so `screenshotPath`
 * works regardless of where `playwright test` is invoked from.
 */
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-06",
);
function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, `${name}.png`);
}

const PROFILE = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
/**
 * `RequireCapability` (apps/admin/src/access/context.tsx) reads capabilities
 * from `AccessProvider`, which `pages/Shell.tsx` populates from this
 * endpoint via `useAccessDocument` (apps/admin/src/access/api.ts). Role
 * "manager" resolves to exactly [operations.read, operations.write] per
 * `ROLE_CAPABILITIES` in packages/domain/src/access/cabinet.ts -- enough for
 * every inventory preparation route, and nothing else (so billing/team/etc.
 * sidebar items and their data fetches stay off).
 */
const ACCESS = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
const PICKUP_ORDERS_EMPTY = { items: [] };

const DIGEST = "0123456789abcdef".repeat(4);

const PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
const LINE_ID = "30000000-0000-4000-8000-000000000001";
const TEMPLATE_ID = "40000000-0000-4000-8000-000000000001";
const INVENTORY_ID = "50000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "60000000-0000-4000-8000-000000000001";

const PRODUCT = {
  id: PRODUCT_ID,
  gtin14: "04600000000006",
  name: "Сироп «Клюква», 0.5 л",
  productGroup: "Безалкогольные напитки",
  chzProductGroupCode: 1,
  boxCapacity: 12,
  palletCapacity: 60,
  unitPrice: "120.00",
  printName: "Клюква 0.5",
  egaisCode: null,
  shelfLifeDays: 365,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const LINE = { id: LINE_ID, name: "Линия 1", createdAt: "2026-01-01T00:00:00.000Z" };
const LABEL_TEMPLATE = {
  id: TEMPLATE_ID,
  name: "Короб 100×150",
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const SHIFT_PLANNING_CONFIG = { defaultBoxLabelTemplateId: null };

const inventoryRow = {
  id: INVENTORY_ID,
  number: "ИНВ-000042",
  status: "preparing",
  mode: "check",
  productId: PRODUCT_ID,
  gtin14: "04600000000006",
  productName: "Сироп «Клюква», 0.5 л",
  lineId: LINE_ID,
  lineName: "Линия 1",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  boxLabelTemplateId: null,
  boxLabelTemplate: null,
  activeSnapshotId: null,
  resultRevision: 0,
  createdAt: "2026-08-28T09:00:00.000Z",
  updatedAt: "2026-08-28T09:00:00.000Z",
};

const EMPTY_BLOCKERS = {
  activeParticipantCount: 0,
  pendingEventCount: 0,
  participantOpenBoxCount: 0,
  openRepackBoxCount: 0,
  unresolvedPrintBoxCount: 0,
};

const CHZ_STATUSES = [
  "EMITTED",
  "INTRODUCED",
  "APPLIED",
  "RETIRED",
  "WRITTEN_OFF",
  "DISAGGREGATION",
] as const;

function importIdFor(status: string): string {
  const index = CHZ_STATUSES.indexOf(status as (typeof CHZ_STATUSES)[number]) + 1;
  return `7000000${index}-0000-4000-8000-000000000001`;
}

/** Six successful uploads, one per ЧЗ status -- enough for the exports step to auto-select a complete snapshot input set (see `latestSuccessfulImports` in InventoryDetailPage.tsx). */
const readyImports = CHZ_STATUSES.map((status) => ({
  id: importIdFor(status),
  declaredStatus: status,
  parsedStatus: status,
  result: "succeeded",
  rowCount: 120,
  errorCount: 0,
  duplicateCount: 0,
  sha256: DIGEST,
  diagnostics: [],
  fileName: `${status.toLowerCase()}.csv`,
  createdAt: "2026-08-28T10:00:00.000Z",
}));

const activeSnapshot = {
  id: SNAPSHOT_ID,
  inventoryId: INVENTORY_ID,
  revision: 1,
  combinedDigest: DIGEST,
  fixedAt: "2026-08-28T11:00:00.000Z",
  inputs: Object.fromEntries(CHZ_STATUSES.map((status) => [status, importIdFor(status)])) as Record<
    (typeof CHZ_STATUSES)[number],
    string
  >,
  counts: {
    emitted: 120,
    introduced: 118,
    applied: 118,
    retired: 0,
    writtenOff: 0,
    disaggregation: 0,
    protected: 2,
    expected: 116,
    packages: 10,
    loose: 6,
  },
};

const CHZ_EXPORTS_EMPTY = { available: true, blockedBy: [], runs: [] };
/**
 * One of the four `CHZ_EXPORT_PREFLIGHT_CODES` (schemas.ts) -- the agent КЭП
 * pairing gate, surfaced by `ChzExportOrderButton` as
 * `pages.inventory.chzExports.blocked.AGENT_NOT_PAIRED`.
 */
const CHZ_EXPORTS_BLOCKED = { available: false, blockedBy: ["AGENT_NOT_PAIRED"], runs: [] };

/**
 * Three of the six statuses already have a successful upload -- enough to
 * show both the "Готово" and "Нет файла" badges side by side on the exports
 * screen, per the MKR-INS-06 screenshot brief. Full completion (all six) is
 * reserved for the `snapshot`/`terminals` scenarios below.
 */
const partiallyReadyImports = readyImports.slice(0, 3);

const LINE_PRESENCE = {
  items: [
    {
      lineId: LINE_ID,
      lineName: "Линия 1",
      assignedStations: 3,
      onlineStations: 2,
      lastSeenAt: "2026-08-28T11:05:00.000Z",
    },
  ],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

type Scenario = "list" | "create" | "exports" | "exportsBlocked" | "snapshot" | "terminals";

/**
 * Every scenario shares the shell/auth fetches (profile, access, pending
 * pickup-order count) and adds only what the target screen needs. Anything
 * not matched aborts and is recorded in `unexpected`, so a screen that
 * quietly needs one more endpoint than expected fails the test instead of
 * rendering a false-positive empty state.
 */
async function installApi(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/profile") return json(route, PROFILE);
    if (path === "/api/access/me") return json(route, ACCESS);
    if (path === "/api/pickup-orders") return json(route, PICKUP_ORDERS_EMPTY);

    if (scenario === "list" && path === "/api/inventories") {
      return json(route, { items: [inventoryRow] });
    }

    if (scenario === "create") {
      if (path === "/api/products") return json(route, { items: [PRODUCT] });
      if (path === "/api/lines") return json(route, { items: [LINE] });
      if (path === "/api/label-templates") return json(route, { items: [LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") return json(route, SHIFT_PLANNING_CONFIG);
    }

    if (
      (scenario === "exports" || scenario === "exportsBlocked") &&
      path === `/api/inventories/${INVENTORY_ID}`
    ) {
      return json(route, {
        ...inventoryRow,
        blockers: EMPTY_BLOCKERS,
        imports: partiallyReadyImports,
        activeSnapshot: null,
      });
    }
    if (scenario === "snapshot" && path === `/api/inventories/${INVENTORY_ID}`) {
      return json(route, {
        ...inventoryRow,
        blockers: EMPTY_BLOCKERS,
        imports: readyImports,
        activeSnapshot: null,
      });
    }
    if (scenario === "terminals" && path === `/api/inventories/${INVENTORY_ID}`) {
      return json(route, {
        ...inventoryRow,
        // Fixing a snapshot moves the inventory to "ready" in the same
        // transaction that sets `activeSnapshotId`
        // (apps/api/src/modules/inventories/inventory-snapshot.service.ts:
        // 279-290 -- `.set({ status: "ready", activeSnapshotId: snapshotId,
        // ... })`), so a mock with a fixed snapshot can never keep
        // "preparing": that combination doesn't exist in production. This
        // scenario backs both the `terminals` and `launch` screenshots, and
        // matches the "ready" status the task-form harness
        // (apps/admin/test/browser/task-form-harness.ts) already uses for
        // the same example inventory.
        status: "ready",
        activeSnapshotId: SNAPSHOT_ID,
        blockers: EMPTY_BLOCKERS,
        imports: readyImports,
        activeSnapshot,
      });
    }
    if (
      (scenario === "exports" || scenario === "snapshot" || scenario === "terminals") &&
      path === `/api/inventories/${INVENTORY_ID}/chz-exports`
    ) {
      return json(route, CHZ_EXPORTS_EMPTY);
    }
    if (scenario === "exportsBlocked" && path === `/api/inventories/${INVENTORY_ID}/chz-exports`) {
      return json(route, CHZ_EXPORTS_BLOCKED);
    }
    if (scenario === "terminals" && path === "/api/lines/presence") {
      return json(route, LINE_PRESENCE);
    }

    unexpected.push(`${route.request().method()} ${path}${url.search}`);
    await route.abort("failed");
  });
  return unexpected;
}

test("renders the inventory list", async ({ page }) => {
  const unexpected = await installApi(page, "list");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/test/browser/inventory.html?route=/inventory");
  await expect(page.getByRole("heading", { level: 1, name: "Инвентаризации" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ИНВ-000042" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("list"), scale: "css" });
});

test("renders the inventory creation parameters screen", async ({ page }) => {
  const unexpected = await installApi(page, "create");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/test/browser/inventory.html?route=/inventory/new");
  await expect(page.getByRole("heading", { level: 1, name: "Новая инвентаризация" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Параметры задания" })).toBeVisible();
  // The "Шаблон этикетки короба" select only renders for the "С
  // переупаковкой" mode (InventoryParametersForm.tsx) -- switch to it so the
  // screenshot's table cell ("продукт, «Способ инвентаризации», линия,
  // шаблон, даты") is fully satisfied.
  await page.getByRole("radio", { name: "С переупаковкой" }).click();
  await expect(page.getByText("Шаблон этикетки короба")).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("parameters"), scale: "css" });
});

test("renders the ЧЗ exports stage of an existing inventory", async ({ page }) => {
  const unexpected = await installApi(page, "exports");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Выписки по статусам кодов" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Заказать из Честного Знака" })).toBeVisible();
  await expect(page.getByText("Готово").first()).toBeVisible();
  await expect(page.getByText("Нет файла").first()).toBeVisible();
  // All six ЧЗ statuses (apps/admin/src/pages/inventory/schemas.ts's
  // INVENTORY_CHZ_STATUSES) must be visible in the same picture -- the fixed
  // two-column upload grid (inventory.css's .mk-inventory-upload-grid) is
  // taller than 800px for six cards, so this is the one screenshot in the
  // set that isn't cropped to 1280x800.
  for (const label of ["Эмитирован", "В обороте", "Нанесён", "Выбыл", "Списан", "Расформирован"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  expect(unexpected).toEqual([]);
  // `AppShell` (apps/admin/src/layout/AppShell.tsx) pins the whole shell to
  // `height: 100vh; overflow: hidden` and scrolls internally inside its
  // `<main>` (`flex: 1; overflow-y: auto`) -- so the *document* never
  // overflows and Playwright's `fullPage` screenshot option is a no-op here
  // (it measures document scroll height, which stays at the viewport size).
  // Growing the viewport itself grows `100vh`, which grows `<main>` until
  // its content fits without internal scrolling; then a normal screenshot
  // at that taller size captures all six cards. Only this file uses a
  // non-800 height -- every other screenshot in this suite stays 1280x800.
  const overflow = await page
    .locator("main")
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  if (overflow > 0) {
    await page.setViewportSize({ width: 1280, height: 800 + overflow });
  }
  await page.screenshot({ path: screenshotPath("exports"), scale: "css", fullPage: true });
});

test("renders a blocked ЧЗ export order", async ({ page }) => {
  const unexpected = await installApi(page, "exportsBlocked");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Выписки по статусам кодов" }),
  ).toBeVisible();
  await expect(page.getByText("Подключите агент КЭП в разделе «Интеграции»")).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("exports-blocked"), scale: "css" });
});

test("renders the snapshot review stage once every ЧЗ status is ready", async ({ page }) => {
  const unexpected = await installApi(page, "snapshot");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Выписки по статусам кодов" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Проверить снимок" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Проверка снимка" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("snapshot"), scale: "css" });
});

test("renders the terminals stage once a snapshot is fixed", async ({ page }) => {
  const unexpected = await installApi(page, "terminals");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID}`);
  await expect(page.getByRole("heading", { level: 2, name: "Доступ терминалов" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("terminals"), scale: "css" });
});

test("renders the real printable task form template", async ({ page }) => {
  // `TerminalsStep`'s «Открыть форму-задание» button
  // (apps/admin/src/pages/inventory/InventoryDetailPage.tsx) opens
  // `GET /api/inventories/:id/task-form` in a new tab -- a real Nest route
  // (apps/api/src/modules/inventories/inventories.controller.ts) that
  // server-renders a self-contained `text/html` A4 page
  // (`renderInventoryTaskFormHtml`, inventory-task-form.ts) straight from
  // the database. That route needs a live DB-backed API server this browser
  // harness doesn't run, so this screenshot instead exercises the same
  // real, pure render function directly -- see
  // apps/admin/test/browser/task-form-harness.ts, which imports it with a
  // hand-built `InventoryTaskFormData` and writes its actual return value
  // (including a genuine `renderCode128Svg` Code 128 barcode from
  // `@markiro/domain`, not a stand-in) as the document. No network mocking
  // is involved for this screen at all.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/test/browser/task-form.html");
  await expect(page.getByRole("heading", { name: "Задание на инвентаризацию" })).toBeVisible();
  await expect(page.getByText("ИНВ-000042").first()).toBeVisible();
  await expect(page.getByText("Параметры задания")).toBeVisible();
  await expect(page.locator(".barcode svg")).toBeVisible();
  await page.screenshot({ path: screenshotPath("task-form"), scale: "css" });
});

test("renders the launch stage after continuing past terminals", async ({ page }) => {
  const unexpected = await installApi(page, "terminals");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID}`);
  await expect(page.getByRole("heading", { level: 2, name: "Доступ терминалов" })).toBeVisible();
  await page.getByRole("button", { name: "К запуску" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Запуск инвентаризации" }),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("launch"), scale: "css" });
});
