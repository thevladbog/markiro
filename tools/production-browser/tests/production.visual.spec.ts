import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * MKR-INS-08 (printed shift-planning instruction) screenshot targets. Mock
 * shapes follow the real response contracts in
 * apps/admin/src/pages/{shifts,catalog,counterparties,labels,devices}/api.ts.
 * Unlike the inventory pages these clients do not re-parse responses with
 * `zod`, so a wrong shape renders as blank cells instead of throwing --
 * every fixture below therefore mirrors its DTO field for field.
 *
 * Same synthetic "Марка Ко" organisation as the inventory evidence suite,
 * and the same manager (Игорь Волков), so the printed series reads as one
 * cabinet.
 */
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-08",
);
function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, `${name}.png`);
}

/**
 * Side panels (`ShiftPanelRoute`, `LinePanelRoute`) slide in over the list,
 * and an assertion on their content passes while the transition is still
 * running -- the first captures caught a half-open panel with the list
 * bleeding through and labels overlapping. Wait until every finite animation
 * on the page has finished so the frame shows a state the manager actually
 * sees. Infinite animations (spinners) are excluded: they never finish by
 * definition, and by screenshot time the content they cover has loaded.
 */
async function settle(page: Page): Promise<void> {
  // An assertion resolves on the frame the element appears, which can be
  // before its entrance transition has been registered -- so give the browser
  // one frame to start animating before waiting for animations to finish.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => (animation.effect?.getTiming().iterations ?? 1) !== Infinity)
      .every((animation) => animation.playState === "finished"),
  );
  // The text caret blinks forever, so whether it is drawn depends purely on
  // when the capture lands: two runs of the same test produced files differing
  // by an 8x40 sliver at the focused field. Hiding it keeps the frames
  // reproducible and costs nothing -- no step in this document is about a
  // cursor.
  // Overlay scrollbars fade on their own schedule and are not reported by
  // `getAnimations()`, so a capture can land mid-fade -- two runs differed by
  // a 2px sliver at a container edge. The viewport is grown past the overflow
  // before capturing anyway, so by then the bars carry no information.
  await page.addStyleTag({
    content:
      "* { caret-color: transparent !important; }\n" +
      "::-webkit-scrollbar { display: none !important; }",
  });
}

/**
 * `AppShell` pins the shell to `height: 100vh; overflow: hidden` and scrolls
 * internally, so a fixed 1280x800 screenshot silently crops anything below
 * the fold instead of failing. Grow the viewport by the page's actual
 * overflow before capturing; a no-op when everything already fits. Same
 * intent as the inventory suite's `screenshotFullMain`, widened because the
 * side panel scrolls in its own container rather than in `<main>`.
 */
async function screenshotFullMain(page: Page, path: string): Promise<void> {
  await settle(page);
  // Both the shell's `<main>` and the side panel's body scroll internally, so
  // the largest vertical overflow anywhere on the page is what a fixed
  // viewport would crop. Measuring every scrollable container instead of one
  // named element keeps this honest when a new screen scrolls somewhere else.
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")].reduce(
      (worst, element) => {
        const style = getComputedStyle(element);
        const scrollable = (value: string) => value === "auto" || value === "scroll";
        return {
          y: scrollable(style.overflowY)
            ? Math.max(worst.y, element.scrollHeight - element.clientHeight)
            : worst.y,
          x: scrollable(style.overflowX)
            ? Math.max(worst.x, element.scrollWidth - element.clientWidth)
            : worst.x,
        };
      },
      { x: 0, y: 0 },
    ),
  );
  if (overflow.x > 0 || overflow.y > 0) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.setViewportSize({
      width: viewport.width + overflow.x,
      height: viewport.height + overflow.y,
    });
    await settle(page);
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
/**
 * `RequireCapability` (apps/admin/src/access/context.tsx) reads capabilities
 * from `AccessProvider`, which `pages/Shell.tsx` populates from this
 * endpoint. Role "manager" resolves to exactly [operations.read,
 * operations.write] per `ROLE_CAPABILITIES` in
 * packages/domain/src/access/cabinet.ts -- enough for shifts, lines and
 * devices, and nothing else, so unrelated sidebar items and their fetches
 * stay off.
 */
const ACCESS = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
/**
 * Adding a station and choosing its line is gated on `credentials.manage`
 * (`apps/admin/src/pages/devices/index.tsx:84` -- `allowStation =
 * canManageCredentials`), which `ROLE_CAPABILITIES` grants to admin and
 * owner but NOT to manager. So the device drawer is shot under an admin,
 * and the document says the step needs those rights instead of pretending
 * the operations manager can do it.
 */
const ACCESS_ADMIN = {
  roles: ["admin"],
  capabilities: [
    "operations.read",
    "operations.write",
    "integrations.read",
    "integrations.write",
    "tenant.settings.manage",
    "billing.read",
    "billing.request",
    "credentials.manage",
    "members.manage",
  ],
};
const PICKUP_ORDERS_EMPTY = { items: [] };

const PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_PRODUCT_ID = "20000000-0000-4000-8000-000000000002";
const ARCHIVED_PRODUCT_ID = "20000000-0000-4000-8000-000000000003";
const LINE_ID = "30000000-0000-4000-8000-000000000001";
const SECOND_LINE_ID = "30000000-0000-4000-8000-000000000002";
const THIRD_LINE_ID = "30000000-0000-4000-8000-000000000003";
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
  image: null,
};
const DRAFT_PRODUCT = {
  ...PRODUCT,
  id: DRAFT_PRODUCT_ID,
  gtin14: "04600000000013",
  name: "Сироп «Малина», 0.5 л",
  printName: "Сироп Малина 0.5",
  status: "draft",
  defaultCounterpartyId: null,
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
  createdAt: "2026-05-18T11:05:00.000Z",
};

const LINE = { id: LINE_ID, name: "Линия розлива №1", createdAt: "2026-08-01T06:00:00.000Z" };
const SECOND_LINE = {
  id: SECOND_LINE_ID,
  name: "Линия розлива №2",
  createdAt: "2026-08-14T06:00:00.000Z",
};
const THIRD_LINE = {
  id: THIRD_LINE_ID,
  name: "Линия фасовки",
  createdAt: "2026-08-28T06:00:00.000Z",
};

/**
 * `LinesPage` renders "Станции не назначены" when `assignedStations === 0`,
 * the "Онлайн · {{online}} из {{total}} станций" chip when
 * `onlineStations > 0`, and "Офлайн" otherwise
 * (apps/admin/src/pages/lines/index.tsx:129-148). All three states appear on
 * the `lines-list` frame, because the document names all three.
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
  {
    lineId: THIRD_LINE_ID,
    lineName: THIRD_LINE.name,
    assignedStations: 0,
    onlineStations: 0,
    lastSeenAt: null,
  },
];

const COUNTERPARTY = {
  id: COUNTERPARTY_ID,
  name: "ООО «Ягодный дом»",
  gln: "4600000000001",
  inn: "7736207543",
  gs1Prefixes: ["0460000"],
  notes: null,
  createdAt: "2026-07-11T08:00:00.000Z",
};
const LABEL_TEMPLATE = {
  id: TEMPLATE_ID,
  name: "Короб 100×150",
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  updatedAt: "2026-08-20T10:00:00.000Z",
};
const SHIFT_PLANNING_CONFIG = { defaultBoxLabelTemplateId: TEMPLATE_ID };

/**
 * Number format comes from `formatInventoryNumber`'s sibling for shifts --
 * `apps/admin/src/pages/shifts/api.ts:24` documents it as `AUG26-003`, with
 * a `/S` suffix for station-created shifts. A hand-invented format would put
 * a number in the printed instruction that the product never produces.
 */
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

// --- MKR-INS-09 (shift monitoring, closing and reports) fixtures ----------

const SCREENSHOT_DIR_09 = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-09",
);
function screenshotPath09(name: string): string {
  return join(SCREENSHOT_DIR_09, `${name}.png`);
}

const ACTIVE_SHIFT_09_ID = "80000000-0000-4000-8000-000000000005";
const ACTIVE_SHIFT_09 = {
  ...ACTIVE_SHIFT,
  id: ACTIVE_SHIFT_09_ID,
  number: "SEP26-004",
  plannedDate: "2026-09-02",
  productionDate: "2026-09-02",
  openedAt: "2026-09-02T04:10:00.000Z",
  createdAt: "2026-09-01T14:00:00.000Z",
};
const CLOSED_SHIFT = {
  ...ACTIVE_SHIFT_09,
  id: "80000000-0000-4000-8000-000000000003",
  number: "SEP26-003",
  status: "closed",
  plannedDate: "2026-09-01",
  productionDate: "2026-09-01",
  openedAt: "2026-09-01T04:05:00.000Z",
  closedAt: "2026-09-01T12:40:00.000Z",
  closeReason: "Смена завершена по плану",
  createdAt: "2026-08-31T14:00:00.000Z",
};
const LATE_SHIFT = {
  ...CLOSED_SHIFT,
  id: "80000000-0000-4000-8000-000000000004",
  number: "SEP26-002",
  lateDataAt: "2026-09-01T14:05:00.000Z",
};

function dashboardWindow(
  start: string,
  end: string,
  accepted: number,
  boxes: number,
  units: number,
) {
  return {
    start,
    end,
    validation: { acceptedUnits: accepted, shiftHours: 8, unitsPerShiftHour: accepted / 8 },
    aggregation: {
      closedBoxes: boxes,
      containedUnits: units,
      shiftHours: 8,
      boxesPerShiftHour: boxes / 8,
      containedUnitsPerShiftHour: units / 8,
    },
  };
}

/**
 * `/api/dashboard/overview` is parsed with a `.strict()` zod schema
 * (apps/admin/src/pages/dashboard/api.ts:71-118), so these fixtures mirror
 * it field for field. Verdict, quality and the shift list must AGREE — a
 * verdict reason with no matching data on the same frame is a fabrication
 * (the same rule the inventory close-preview fixtures follow).
 *
 * «Производство под контролем»: no reasons, one active shift, so the
 * quality signal is honestly "provisional" with the active_shifts reason.
 */
const DASHBOARD_UNDER_CONTROL = {
  generatedAt: "2026-09-02T05:30:00.000Z",
  timeZone: "Europe/Moscow",
  metricVersion: "operations-dashboard-v1",
  setup: { productCount: 3, shiftCount: 12, hasRunShift: true },
  verdict: { status: "under_control", reasons: [] },
  today: {
    validationAcceptedUnits: 1180,
    aggregationClosedBoxes: 74,
    aggregationContainedUnits: 888,
    activeShiftCount: 1,
    includedClosedShiftCount: 1,
  },
  dynamics: {
    period: "today",
    grain: "hour",
    currentWindow: dashboardWindow(
      "2026-09-02T00:00:00.000Z",
      "2026-09-02T08:00:00.000Z",
      1180,
      74,
      888,
    ),
    comparisonWindow: dashboardWindow(
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T08:00:00.000Z",
      1050,
      66,
      792,
    ),
    buckets: [
      {
        label: "04:00",
        ...dashboardWindow("2026-09-02T04:00:00.000Z", "2026-09-02T05:00:00.000Z", 260, 16, 192),
      },
      {
        label: "05:00",
        ...dashboardWindow("2026-09-02T05:00:00.000Z", "2026-09-02T06:00:00.000Z", 300, 19, 228),
      },
      {
        label: "06:00",
        ...dashboardWindow("2026-09-02T06:00:00.000Z", "2026-09-02T07:00:00.000Z", 310, 20, 240),
      },
      {
        label: "07:00",
        ...dashboardWindow("2026-09-02T07:00:00.000Z", "2026-09-02T08:00:00.000Z", 310, 19, 228),
      },
    ],
    quality: {
      status: "provisional",
      reasons: ["active_shifts"],
      activeShiftCount: 1,
      lateDataShiftCount: 0,
      sources: ["code_registry", "boxes", "box_items"],
    },
  },
  activeShifts: [
    {
      id: ACTIVE_SHIFT_09_ID,
      number: "SEP26-004",
      productName: PRODUCT.name,
      lineName: LINE.name,
      openedAt: "2026-09-02T04:10:00.000Z",
      lateDataAt: null,
      output: { mode: "aggregation", closedBoxes: 74, containedUnits: 888 },
    },
  ],
};

/**
 * «Требует внимания» over late data: the reason appears in verdict.reasons,
 * in the quality signal AND as a late-data shift count — one coherent story.
 */
const DASHBOARD_ATTENTION = {
  ...DASHBOARD_UNDER_CONTROL,
  verdict: {
    status: "needs_attention",
    reasons: [{ code: "late_data", severity: "needs_attention", count: 1, route: "/shifts" }],
  },
  dynamics: {
    ...DASHBOARD_UNDER_CONTROL.dynamics,
    quality: {
      ...DASHBOARD_UNDER_CONTROL.dynamics.quality,
      reasons: ["active_shifts", "late_data"],
      lateDataShiftCount: 1,
    },
  },
};

/**
 * The five report formats the server offers, copied VERBATIM from
 * `SHIFT_EXPORT_FORMATS` in packages/domain/src/shift-exports.ts (this
 * package installs with --ignore-workspace, so the domain package is not
 * importable here). If the catalog changes, this copy must follow — the
 * strict /api/ interception makes any shape drift visible as a blank
 * dialog, and the document quotes these labels from the frame.
 */
const SHIFT_EXPORT_FORMATS_FIXTURE = [
  {
    id: "shift_txt_flat",
    version: 1,
    label: "[TXT][Без коробов] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "flat",
  },
  {
    id: "shift_txt_boxes",
    version: 2,
    label: "[TXT][С коробами] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "boxes",
  },
  {
    id: "shift_csv_flat",
    version: 1,
    label: "[CSV][Без коробов] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "flat",
  },
  {
    id: "shift_csv_boxes",
    version: 1,
    label: "[CSV][С коробами] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "boxes",
  },
  {
    id: "shift_xml_gismt_aggregation",
    version: 1,
    label: "[XML][ГИСМТ] Отчет об агрегации",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    boxMode: "boxes",
  },
];

/** Shapes follow `ShiftExportDto` (apps/admin/src/pages/shifts/shift-exports-api.ts:21-41). */
const EXPORT_READY = {
  id: "a0000000-0000-4000-8000-000000000001",
  shiftId: CLOSED_SHIFT.id,
  formatId: "shift_xml_gismt_aggregation",
  formatVersion: 1,
  maxLines: 1000,
  status: "ready",
  errorCode: null,
  productNameSnapshot: PRODUCT.name,
  shiftDateSnapshot: "2026-09-01",
  totalCodeCount: 888,
  totalBoxCount: 74,
  createdByUserId: "browser_manager",
  createdByName: "Игорь Волков",
  sourceSnapshotStartedAt: "2026-09-01T12:45:00.000Z",
  completedAt: "2026-09-01T12:45:40.000Z",
  attemptCount: 1,
  createdAt: "2026-09-01T12:45:00.000Z",
  stale: false,
  artifacts: [
    {
      id: "b0000000-0000-4000-8000-000000000001",
      partNumber: 1,
      physicalLineCount: 640,
      codeCount: 600,
      boxCount: 50,
      filename: "shift-SEP26-003-aggregation-part1.xml",
      mimeType: "application/xml; charset=utf-8",
      byteSize: 118400,
      sha256: "0123456789abcdef".repeat(4),
    },
    {
      id: "b0000000-0000-4000-8000-000000000002",
      partNumber: 2,
      physicalLineCount: 322,
      codeCount: 288,
      boxCount: 24,
      filename: "shift-SEP26-003-aggregation-part2.xml",
      mimeType: "application/xml; charset=utf-8",
      byteSize: 61240,
      sha256: "89abcdef01234567".repeat(4),
    },
  ],
};
const EXPORT_PROCESSING = {
  ...EXPORT_READY,
  id: "a0000000-0000-4000-8000-000000000002",
  formatId: "shift_csv_boxes",
  formatVersion: 1,
  maxLines: null,
  status: "processing",
  completedAt: null,
  totalCodeCount: null,
  totalBoxCount: null,
  sourceSnapshotStartedAt: "2026-09-01T12:50:00.000Z",
  createdAt: "2026-09-01T12:50:00.000Z",
  artifacts: [],
};
const EXPORT_FAILED = {
  ...EXPORT_READY,
  id: "a0000000-0000-4000-8000-000000000003",
  formatId: "shift_txt_boxes",
  formatVersion: 2,
  status: "failed",
  errorCode: "BOX_COVERAGE_INCOMPLETE",
  completedAt: null,
  totalCodeCount: null,
  totalBoxCount: null,
  attemptCount: 2,
  createdAt: "2026-09-01T12:47:00.000Z",
  artifacts: [],
};
const EXPORT_STALE = {
  ...EXPORT_READY,
  id: "a0000000-0000-4000-8000-000000000004",
  stale: true,
  createdAt: "2026-09-01T13:20:00.000Z",
};

type Scenario =
  | "lines"
  | "linesDeleteBlocked"
  | "devices"
  | "deviceDrawer"
  | "shiftsList"
  | "shiftCreate"
  | "shiftsPlanned"
  | "shiftActiveEdit"
  | "dashboardCalm"
  | "dashboardAttention"
  | "shiftsClose"
  | "shiftsLate"
  | "exportsCatalog"
  | "exportsHistory"
  | "exportsFailed"
  | "exportsStale";

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
    if (path === "/api/access/me") {
      return json(route, scenario === "deviceDrawer" ? ACCESS_ADMIN : ACCESS);
    }
    if (path === "/api/pickup-orders") return json(route, PICKUP_ORDERS_EMPTY);
    // Only the admin shell reaches this one: the badge is gated on
    // `billing.read`, which the manager role does not carry.
    if (scenario === "deviceDrawer" && path === "/api/billing/attention") {
      return json(route, { count: 0 });
    }

    if (scenario === "lines" || scenario === "linesDeleteBlocked") {
      if (path === "/api/lines") return json(route, { items: [LINE, SECOND_LINE, THIRD_LINE] });
      if (path === "/api/lines/presence") return json(route, { items: LINE_PRESENCE });
      if (scenario === "linesDeleteBlocked" && path === `/api/lines/${LINE_ID}`) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "LINE_REFERENCED" }),
        });
      }
    }

    if (scenario === "devices" || scenario === "deviceDrawer") {
      if (path === "/api/devices") return json(route, DEVICES_RESPONSE);
      // The add-device drawer offers the line select, so it loads the lines.
      if (path === "/api/lines") return json(route, { items: [LINE, SECOND_LINE, THIRD_LINE] });
    }

    if (
      scenario === "shiftsList" ||
      scenario === "shiftCreate" ||
      scenario === "shiftsPlanned" ||
      scenario === "shiftActiveEdit"
    ) {
      if (path === "/api/shifts") {
        return json(route, {
          items: scenario === "shiftsPlanned" ? [PLANNED_SHIFT, ACTIVE_SHIFT] : [ACTIVE_SHIFT],
        });
      }
      if (path === "/api/products") {
        return json(route, { items: [PRODUCT, DRAFT_PRODUCT, ARCHIVED_PRODUCT] });
      }
      if (path === "/api/lines") return json(route, { items: [LINE, SECOND_LINE, THIRD_LINE] });
      if (path === "/api/counterparties") return json(route, { items: [COUNTERPARTY] });
      if (path === "/api/label-templates") return json(route, { items: [LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") return json(route, SHIFT_PLANNING_CONFIG);
    }

    if (scenario === "dashboardCalm" || scenario === "dashboardAttention") {
      if (path === "/api/dashboard/overview") {
        return json(
          route,
          scenario === "dashboardCalm" ? DASHBOARD_UNDER_CONTROL : DASHBOARD_ATTENTION,
        );
      }
    }

    const exportScenario =
      scenario === "exportsCatalog" ||
      scenario === "exportsHistory" ||
      scenario === "exportsFailed" ||
      scenario === "exportsStale";
    if (scenario === "shiftsClose" || scenario === "shiftsLate" || exportScenario) {
      if (path === "/api/shifts") {
        return json(route, {
          items:
            scenario === "shiftsClose"
              ? [ACTIVE_SHIFT_09]
              : scenario === "shiftsLate"
                ? [ACTIVE_SHIFT_09, LATE_SHIFT, CLOSED_SHIFT]
                : [CLOSED_SHIFT],
        });
      }
      // The shifts page loads the planning references regardless of what the
      // frame is about -- same set the 08 scenarios serve.
      if (path === "/api/products") {
        return json(route, { items: [PRODUCT, DRAFT_PRODUCT, ARCHIVED_PRODUCT] });
      }
      if (path === "/api/lines") return json(route, { items: [LINE, SECOND_LINE, THIRD_LINE] });
      if (path === "/api/counterparties") return json(route, { items: [COUNTERPARTY] });
      if (path === "/api/label-templates") return json(route, { items: [LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") return json(route, SHIFT_PLANNING_CONFIG);
    }
    if (exportScenario) {
      if (path === "/api/shift-exports/formats") return json(route, SHIFT_EXPORT_FORMATS_FIXTURE);
      if (path === `/api/shifts/${CLOSED_SHIFT.id}/exports`) {
        return json(
          route,
          scenario === "exportsCatalog"
            ? []
            : scenario === "exportsHistory"
              ? [EXPORT_PROCESSING, EXPORT_READY]
              : scenario === "exportsFailed"
                ? [EXPORT_FAILED]
                : [EXPORT_STALE],
        );
      }
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

test("lines list shows all three presence states", async ({ page }) => {
  const unexpected = await installApi(page, "lines");
  await openHarness(page, "/lines");
  await expect(page.getByText("Производственные линии")).toBeVisible();
  await expect(page.getByText("Онлайн · 2 из 3 станций")).toBeVisible();
  await expect(page.getByText("Офлайн")).toBeVisible();
  await expect(page.getByText("Станции не назначены")).toBeVisible();
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
  await page.getByRole("button", { name: "Удалить", exact: true }).last().click();
  await expect(
    page.getByText("Линия используется в сменах или назначена", { exact: false }),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath("line-delete-blocked"));
  expect(unexpected).toEqual([]);
});

/**
 * The devices LIST shows the line under a column headed "Место", not
 * "Линия" -- the "Линия" label with its explanatory hint lives in the
 * device's own drawer (`DeviceDrawer.tsx:316-320`). Both frames exist so the
 * document can name each string against the screen that actually shows it.
 */
test("device list shows its line under Место", async ({ page }) => {
  const unexpected = await installApi(page, "devices");
  await openHarness(page, "/devices");
  await expect(page.getByText("Станция розлива 1")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Место" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("device-list"));
  expect(unexpected).toEqual([]);
});

test("device drawer assigns the line", async ({ page }) => {
  const unexpected = await installApi(page, "deviceDrawer");
  await openHarness(page, "/devices");
  await page.getByRole("button", { name: "Добавить устройство" }).click();
  await expect(
    page.getByText("Выбранная линия задаёт для станции", { exact: false }),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath("device-line"));
  expect(unexpected).toEqual([]);
});

test("shifts list before planning", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsList");
  await openHarness(page, "/shifts");
  await expect(page.getByText("AUG26-002")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shifts-list"));
  expect(unexpected).toEqual([]);
});

/**
 * A draft or archived product is listed but NOT selectable: `ShiftForm.tsx`
 * builds each option with `disabled: product.archived || product.status ===
 * "draft"` (:286) and appends "(черновик — недоступно)" / "(не
 * используется)" to the label (:281-285). This is the opposite of the
 * inventory form, where an archived product is deliberately selectable --
 * hence its own frame, so the printed claim rests on a picture.
 */
test("shift form: draft and archived products are listed but disabled", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await page.getByRole("combobox", { name: "Продукт" }).click();
  await expect(page.getByText("черновик — недоступно")).toBeVisible();
  await expect(page.getByText("не используется")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-product-options"));
  expect(unexpected).toEqual([]);
});

/**
 * Picking a product prefills the counterparty and the capacities from that
 * product's defaults (`ShiftForm.tsx:205,221-234`), which is a frequent
 * "why did this appear?" question -- so the frame shows the form after the
 * choice, not an empty one.
 */
test("shift form: choosing a product prefills the counterparty", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await page.getByRole("combobox", { name: "Продукт" }).click();
  await page.getByRole("option", { name: PRODUCT.name, exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Для контрагента (толлинг)" })).toHaveText(
    COUNTERPARTY.name,
  );
  await screenshotFullMain(page, screenshotPath("shift-filled"));
  expect(unexpected).toEqual([]);
});

/**
 * The "Агрегация" section only renders while `shiftMode === "aggregation"`
 * (`ShiftForm.tsx:536`), and a new form starts in "validation" (form
 * defaults, :101). So the capacities and pallet fields genuinely do not
 * exist until the manager picks the mode. Shot after the product is chosen
 * too, so the prefilled capacities (12 / 48 from the product) are visible.
 */
test("shift form: templates and aggregation", async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate");
  await openHarness(page, "/shifts/new");
  await page.getByRole("combobox", { name: "Продукт" }).click();
  await page.getByRole("option", { name: PRODUCT.name, exact: true }).click();
  await page.getByRole("radio", { name: "Агрегация" }).check();
  await expect(page.getByText("Использовать паллеты")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-aggregation"));
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

/**
 * While a shift is active the form locks everything except the planned
 * quantity and the two dates (`ShiftForm.tsx`'s `activeEdit` flag disables
 * product, mode, line, counterparty, SSCC issuer, template and capacities).
 */
test("an active shift locks most of its form", async ({ page }) => {
  const unexpected = await installApi(page, "shiftActiveEdit");
  await openHarness(page, `/shifts/${ACTIVE_SHIFT_ID}/edit`);
  await expect(page.getByText("Изменить смену · AUG26-002")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-active-locked"));
  expect(unexpected).toEqual([]);
});

/**
 * Submitting ANY edit of an active shift routes through the confirmation
 * instead of persisting: `ShiftPanelRoute.tsx:254-258` sets `criticalInput`
 * whenever `shift.status === "active"`, which opens the "Критическое
 * изменение активной смены" dialog.
 */
test("saving an active shift asks for confirmation", async ({ page }) => {
  const unexpected = await installApi(page, "shiftActiveEdit");
  await openHarness(page, `/shifts/${ACTIVE_SHIFT_ID}/edit`);
  await page.getByLabel("Плановое количество, шт").fill("5200");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Критическое изменение активной смены")).toBeVisible();
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

// --- MKR-INS-09 frames -----------------------------------------------------

test("dashboard: production under control", async ({ page }) => {
  const unexpected = await installApi(page, "dashboardCalm");
  await openHarness(page, "/");
  await expect(page.getByText("Производство под контролем")).toBeVisible();
  await expect(page.getByText("Активных причин для вмешательства нет.")).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("dashboard-under-control"));
  expect(unexpected).toEqual([]);
});

test("dashboard: needs attention over late data", async ({ page }) => {
  const unexpected = await installApi(page, "dashboardAttention");
  await openHarness(page, "/");
  await expect(page.getByText("Требует внимания")).toBeVisible();
  await expect(page.getByText("Поздние данные затронули 1 смену")).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("dashboard-attention"));
  expect(unexpected).toEqual([]);
});

test("shifts list: active shift offers the close action", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose");
  await openHarness(page, "/shifts");
  await expect(page.getByText("SEP26-004")).toBeVisible();
  await expect(page.getByRole("button", { name: "Закрыть смену" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("shifts-active"));
  expect(unexpected).toEqual([]);
});

test("closing a shift from the cabinet asks for a reason", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Закрыть смену" }).click();
  await expect(page.getByText("Причина закрытия")).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("shift-close"));
  expect(unexpected).toEqual([]);
});

test("late data badge on a closed shift", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsLate");
  await openHarness(page, "/shifts");
  await expect(page.getByText("Данные после закрытия")).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("shifts-late-badge"));
  expect(unexpected).toEqual([]);
});

/**
 * The report dialog only exists on CLOSED shifts (`ShiftExportAction` renders
 * for `row.status === "closed"`, apps/admin/src/pages/shifts/index.tsx:372),
 * so every export frame starts from CLOSED_SHIFT's row.
 */
test("report dialog: format catalog and split controls", async ({ page }) => {
  const unexpected = await installApi(page, "exportsCatalog");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Сформировать отчет" }).click();
  await expect(page.getByText("[XML][ГИСМТ] Отчет об агрегации")).toBeVisible();
  await expect(page.getByText("Разделить отчет на части")).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("exports-catalog"));
  expect(unexpected).toEqual([]);
});

test("report dialog: history with ready parts and a processing run", async ({ page }) => {
  const unexpected = await installApi(page, "exportsHistory");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Сформировать отчет" }).click();
  await expect(page.getByText("Готов", { exact: true })).toBeVisible();
  await expect(page.getByText("Формируется")).toBeVisible();
  await expect(page.getByText("Часть 1")).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("exports-history"));
  expect(unexpected).toEqual([]);
});

test("report dialog: failed run explains itself and offers a retry", async ({ page }) => {
  const unexpected = await installApi(page, "exportsFailed");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Сформировать отчет" }).click();
  await expect(page.getByText("Не все коды смены распределены по коробам.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("exports-failed"));
  expect(unexpected).toEqual([]);
});

test("report dialog: stale run warns after late data", async ({ page }) => {
  const unexpected = await installApi(page, "exportsStale");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Сформировать отчет" }).click();
  await expect(
    page.getByText("Данные смены изменились — сформируйте новый отчет."),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath09("exports-stale"));
  expect(unexpected).toEqual([]);
});
