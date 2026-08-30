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

/**
 * `TerminalsStep`'s «Открыть форму-задание» button
 * (apps/admin/src/pages/inventory/InventoryDetailPage.tsx) calls
 * `window.open("/api/inventories/:id/task-form", "_blank")` -- a real Nest
 * route (apps/api/src/modules/inventories/inventories.controller.ts) that
 * server-renders a self-contained `text/html` A4 page
 * (`renderInventoryTaskFormHtml` in inventory-task-form.ts) straight from the
 * database, not JSON and not a client-side route. That renderer needs a live
 * DB-backed API server this harness doesn't run, so -- same discipline as
 * every JSON endpoint above -- the response is mocked at the network
 * boundary. It's mocked via `context.route`, not `page.route`, because the
 * popup tab the button opens is a second `Page` in the same `BrowserContext`
 * and only context-level routes apply to it. The markup below mirrors the
 * real template's section order, headings, and field labels
 * (ПРОДУКТ/GTIN/ЛИНИЯ/РЕЖИМ/ДАТА ПРОИЗВОДСТВА/ОЖИДАЕТСЯ К ПРОВЕРКЕ); the
 * barcode is a hand-drawn Code128-style bar pattern standing in for the real
 * `bwip-js`-rendered SVG, since that dependency isn't installed in this
 * test-only package (see task-2-report.md for the full rationale).
 */
function taskFormBarcodeSvg(token: string): string {
  let x = 0;
  const rects: string[] = [];
  for (const codePoint of token) {
    const width = 2 + (codePoint.codePointAt(0)! % 3);
    rects.push(`<rect x="${x}" width="${width}" height="80" />`);
    x += width + 2;
  }
  return `<svg viewBox="0 0 ${x} 80" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><rect width="${x}" height="80" fill="#fff"/><g fill="#17161a">${rects.join("")}</g></svg>`;
}

function taskFormFixtureHtml(): string {
  const token = `markiro:inventory:v1:${INVENTORY_ID}`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Форма-задание на инвентаризацию ${inventoryRow.number}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #efefed; color: #17161a; font-family: Arial, "Helvetica Neue", sans-serif; }
  .page { width: 210mm; height: 297mm; margin: 0 auto; padding: 16mm; background: #fafaf8; display: flex; flex-direction: column; box-shadow: 0 2mm 8mm rgba(23, 22, 26, .12); }
  .top { display: flex; justify-content: space-between; align-items: center; padding-bottom: 6mm; border-bottom: .25mm solid #cbc7bf; }
  .brand { font-weight: 700; font-size: 20pt; }
  .task-id { text-align: right; }
  .eyebrow { display: block; color: #706d67; font-size: 8pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .task-id strong { display: block; margin-top: 1.5mm; font: 700 14pt/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; }
  .hero { display: grid; grid-template-columns: 1fr auto; gap: 8mm; align-items: end; padding: 8mm 0 7mm; }
  h1 { margin: 0; font-size: 23pt; line-height: 1.08; letter-spacing: -.02em; }
  .subtitle { margin: 2.5mm 0 0; color: #4f4c47; font-size: 11pt; }
  .status { min-width: 36mm; padding: 4mm 5mm; border: .25mm solid #b7dfc8; border-radius: 3mm; background: #e7f6ed; color: #126b39; font-size: 9pt; font-weight: 800; text-align: center; text-transform: uppercase; }
  .scan-zone { height: 43mm; border: .35mm solid #cbc7bf; border-radius: 4mm; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #fff; }
  .barcode { width: 150mm; height: 17mm; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .barcode svg { display: block; width: 100%; height: 100%; }
  .barcode-caption { margin-top: 1mm; font: 700 12pt/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; }
  .scan-hint { margin-top: 1mm; color: #77736d; font-size: 8pt; }
  h2 { margin: 4.5mm 0 2mm; font-size: 12pt; line-height: 1.2; }
  dl { margin: 0; }
  .parameter { min-height: 8mm; display: grid; grid-template-columns: 1fr minmax(62mm, auto); align-items: center; gap: 6mm; border-bottom: .2mm solid #d8d5cf; }
  dt { color: #706d67; font-size: 8pt; }
  dd { margin: 0; max-width: 110mm; text-align: right; font-size: 10pt; font-weight: 700; overflow-wrap: anywhere; }
  .steps { margin-top: 4mm; padding-top: 1mm; border-top: .2mm solid #d8d5cf; }
  .steps ol { display: grid; gap: 2mm; margin: 0; padding: 0; list-style: none; }
  .steps li { display: grid; grid-template-columns: 7mm 1fr; gap: 3mm; align-items: start; color: #4f4c47; font-size: 8.5pt; line-height: 1.28; }
  .step-number { width: 6mm; height: 6mm; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: #17161a; color: #fff; font-size: 7pt; font-weight: 800; }
  .rules { margin-top: 5mm; padding: 4mm 5mm; border: .25mm solid #c6daf5; border-radius: 3.5mm; background: #e6f0fd; color: #1756a6; }
  .rules h2 { margin: 0 0 2mm; color: #1756a6; }
  .rules ul { margin: 0; padding-left: 5mm; display: grid; gap: 1.2mm; font-size: 8pt; line-height: 1.25; }
  .footer { margin-top: auto; padding-top: 3.5mm; border-top: .2mm solid #d8d5cf; display: flex; justify-content: space-between; color: #77736d; font-size: 7.5pt; }
</style>
</head>
<body>
  <main class="page">
    <header class="top"><span class="brand">маркиро</span><div class="task-id"><span class="eyebrow">Форма-задание</span><strong>${inventoryRow.number}</strong></div></header>
    <section class="hero"><div><h1>Задание на инвентаризацию</h1><p class="subtitle">Без переупаковки · Марка Ко</p></div><div class="status">К запуску</div></section>
    <section class="scan-zone" aria-label="Штрихкод задания"><div class="barcode" data-task-token="${token}">${taskFormBarcodeSvg(token)}</div><div class="barcode-caption">${inventoryRow.number}</div><div class="scan-hint">Отсканируйте на терминале, чтобы открыть задание</div></section>
    <section><h2>Параметры задания</h2><dl>
      <div class="parameter"><dt>ПРОДУКТ</dt><dd>${PRODUCT.name}</dd></div>
      <div class="parameter"><dt>GTIN</dt><dd>${PRODUCT.gtin14}</dd></div>
      <div class="parameter"><dt>ЛИНИЯ</dt><dd>${LINE.name}</dd></div>
      <div class="parameter"><dt>РЕЖИМ</dt><dd>Без переупаковки</dd></div>
      <div class="parameter"><dt>ДАТА ПРОИЗВОДСТВА</dt><dd>01.08.2026 - 31.08.2026</dd></div>
      <div class="parameter"><dt>ОЖИДАЕТСЯ К ПРОВЕРКЕ</dt><dd>${activeSnapshot.counts.expected} кодов</dd></div>
    </dl></section>
    <section class="steps"><h2>Как начать работу</h2><ol>
      <li><span class="step-number">1</span><span>Откройте терминал на выбранной линии и войдите оператором.</span></li>
      <li><span class="step-number">2</span><span>Отсканируйте штрихкод задания. На своей линии оно также будет видно в списке.</span></li>
      <li><span class="step-number">3</span><span>Если терминал относится к другой линии, подтвердите предупреждение перед входом.</span></li>
      <li><span class="step-number">4</span><span>Сканируйте коды единиц. Закрытую упаковку можно проверить одним сканированием кода упаковки.</span></li>
    </ol></section>
    <aside class="rules"><h2>Важные правила</h2><ul>
      <li><strong>MOVING_BY_UD:</strong> код в отгрузке. Его нельзя учитывать, списывать или включать в документы.</li>
      <li>При простой проверке сканирование кода короба отмечает его известное содержимое.</li>
      <li>Дата производства действует на терминале до следующего изменения; в одном новом коробе одна дата.</li>
      <li>Чтобы поставить работу на паузу, выйдите из задания. Закрыть инвентаризацию можно только в админке.</li>
      <li>На время инвентаризации движения продукции по складу остановлены.</li>
    </ul></aside>
    <footer class="footer"><span>Сформировано: 28.08.2026 14:00 · Маркиро</span><span>${inventoryRow.number} · 1 / 1</span></footer>
  </main>
</body>
</html>`;
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
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath("exports"), scale: "css" });
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

test("opens the printable task form for a fixed snapshot", async ({ page, context }) => {
  const unexpected = await installApi(page, "terminals");
  await context.route(`**/api/inventories/${INVENTORY_ID}/task-form`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: taskFormFixtureHtml(),
    }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID}`);
  await expect(page.getByRole("heading", { level: 2, name: "Доступ терминалов" })).toBeVisible();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Открыть форму-задание" }).click(),
  ]);
  await popup.waitForLoadState();
  await popup.setViewportSize({ width: 1280, height: 800 });
  await expect(popup.getByText("Задание на инвентаризацию")).toBeVisible();
  expect(unexpected).toEqual([]);
  await popup.screenshot({ path: screenshotPath("task-form"), scale: "css" });
  await popup.close();
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
