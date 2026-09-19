import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { adminI18n, type AdminLocale } from "./admin-i18n.js";

/**
 * MKR-INS-08 (printed shift-planning instruction) screenshot targets. Mock
 * shapes follow the real response contracts in
 * apps/admin/src/pages/{shifts,catalog,counterparties,labels,devices}/api.ts.
 * Unlike the inventory pages these clients do not re-parse responses with
 * `zod`, so a wrong shape renders as blank cells instead of throwing --
 * every fixture below therefore mirrors its DTO field for field.
 *
 * Same synthetic organisation as the inventory evidence suite («Марка Ко» /
 * "Marka Co"), and the same manager (Игорь Волков / Igor Volkov), so the
 * printed series reads as one cabinet.
 *
 * Every frame is captured once per locale: the Russian instruction and its
 * English twin are shot from the SAME assertions, so the two documents can
 * never drift into illustrating different states of the cabinet.
 */
const LOCALES: readonly AdminLocale[] = ["ru", "en"];

type Translate = ReturnType<typeof adminI18n>["t"];

function screenshotDir(locale: AdminLocale): string {
  return join(
    import.meta.dirname,
    `../../../packages/legal-documents/assets/instructions/mkr-ins-08/${locale}`,
  );
}
function screenshotPath(locale: AdminLocale, name: string): string {
  return join(screenshotDir(locale), `${name}.png`);
}

/** MKR-INS-09 (shift monitoring, closing and reports) screenshot targets. */
function screenshotDir09(locale: AdminLocale): string {
  return join(
    import.meta.dirname,
    `../../../packages/legal-documents/assets/instructions/mkr-ins-09/${locale}`,
  );
}
function screenshotPath09(locale: AdminLocale, name: string): string {
  return join(screenshotDir09(locale), `${name}.png`);
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

/**
 * Fixture text the frames actually SHOW. Interface strings come from the
 * app's dictionaries (see `adminI18n`), but product names, line names and
 * people are the tenant's own data, which no dictionary carries -- so the
 * English cabinet gets an English tenant instead of Cyrillic rows under an
 * English chrome. The `ru` column is verbatim what the Russian series has
 * always carried, so those frames stay byte-comparable.
 */
const COPY = {
  ru: {
    managerFirstName: "Игорь",
    managerLastName: "Волков",
    managerFullName: "Игорь Волков",
    product: "Сироп «Клюква», 0.5 л",
    productPrintName: "Сироп Клюква 0.5",
    draftProduct: "Сироп «Малина», 0.5 л",
    draftProductPrintName: "Сироп Малина 0.5",
    archivedProduct: "Сироп «Груша», 0.5 л",
    archivedProductPrintName: "Сироп Груша 0.5",
    productGroup: "Безалкогольные напитки",
    line: "Линия розлива №1",
    secondLine: "Линия розлива №2",
    thirdLine: "Линия фасовки",
    counterparty: "ООО «Ягодный дом»",
    boxLabelTemplate: "Короб 100×150",
    productLabelTemplate: "Дубликат Data Matrix 58×40 [Краткое наименование]",
    station: "Станция розлива 1",
    closeReason: "Смена завершена по плану",
    participant: "Мария Кузнецова",
    participantRole: "Оператор линии",
    secondParticipant: "Пётр Смирнов",
  },
  en: {
    managerFirstName: "Igor",
    managerLastName: "Volkov",
    managerFullName: "Igor Volkov",
    product: "Cranberry syrup, 0.5 L",
    productPrintName: "Cranberry syrup 0.5",
    draftProduct: "Raspberry syrup, 0.5 L",
    draftProductPrintName: "Raspberry syrup 0.5",
    archivedProduct: "Pear syrup, 0.5 L",
    archivedProductPrintName: "Pear syrup 0.5",
    productGroup: "Soft drinks",
    line: "Bottling line 1",
    secondLine: "Bottling line 2",
    thirdLine: "Packing line",
    counterparty: "Berry House LLC",
    boxLabelTemplate: "Box 100×150",
    productLabelTemplate: "Data Matrix duplicate 58×40 [Short name]",
    station: "Bottling station 1",
    closeReason: "Shift finished as planned",
    participant: "Maria Kuznetsova",
    participantRole: "Line operator",
    secondParticipant: "Pyotr Smirnov",
  },
} as const satisfies Record<AdminLocale, Record<string, string>>;

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
const PRODUCT_LABEL_TEMPLATE_ID = "40000000-0000-4000-8000-000000000002";
const ACTIVE_SHIFT_09_ID = "80000000-0000-4000-8000-000000000005";
const CLOSED_SHIFT_ID = "80000000-0000-4000-8000-000000000003";
const LATE_SHIFT_ID = "80000000-0000-4000-8000-000000000004";

/**
 * Pallets get their own id space (`5…`). They used to start at
 * `90000000-…-000000000001`, which is STATION_ID: two different objects
 * sharing one identifier in a fixture that exists to show the product's real
 * data.
 */
function palletUuid(serial: number): string {
  return `50000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
}
/**
 * A real SSCC: the 20 characters the cabinet stores ("00" + the 18-digit
 * SSCC), whose last digit is the GS1 mod-10 check digit over the preceding
 * 17. The frames print these numbers, so a reader who verifies one has to
 * find it correct.
 */
function palletSscc(serial: number): string {
  const body = `3460068200000${String(serial).padStart(4, "0")}`;
  const sum = [...body].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1),
    0,
  );
  return `00${body}${(10 - (sum % 10)) % 10}`;
}

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
 * The five report formats the server offers, copied VERBATIM from
 * `SHIFT_EXPORT_FORMATS` in packages/domain/src/shift-exports.ts (this
 * package installs with --ignore-workspace, so the domain package is not
 * importable here). If the catalog changes, this copy must follow — the
 * strict /api/ interception makes any shape drift visible as a blank
 * dialog, and the document quotes these labels from the frame.
 *
 * These labels are NOT localized: the domain package hardcodes them in
 * Russian and the server sends them as-is, so the English frame shows the
 * same Russian catalog the English cabinet really shows today.
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
    version: 2,
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
  {
    id: "shift_txt_pallets",
    version: 1,
    label: "[TXT][Паллеты] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "pallets",
  },
  {
    id: "shift_csv_pallets",
    version: 1,
    label: "[CSV][Паллеты] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "pallets",
  },
  {
    id: "shift_xml_gismt_aggregation_pallets",
    version: 1,
    label: "[XML][ГИСМТ] Паллетная агрегация",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    boxMode: "pallets",
  },
  {
    id: "shift_txt_pallet_boxes",
    version: 1,
    label: "[TXT][Паллеты → короба] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "pallet_boxes",
  },
  {
    id: "shift_xml_gismt_pallet_boxes",
    version: 1,
    label: "[XML][ГИСМТ] Агрегация паллет без кодов",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    boxMode: "pallet_boxes",
  },
];

/**
 * Everything the mocked API serves, rebuilt per locale. Only the tenant's
 * own text differs between the two builds -- ids, dates and counts are
 * shared, so the RU and EN frames document the same numbers.
 */
function fixtures(locale: AdminLocale) {
  const copy = COPY[locale];

  const PROFILE = {
    firstName: copy.managerFirstName,
    middleName: null,
    lastName: copy.managerLastName,
    hasAvatar: false,
  };

  const PRODUCT = {
    id: PRODUCT_ID,
    gtin14: "04600000000006",
    name: copy.product,
    productGroup: copy.productGroup,
    chzProductGroupCode: 15,
    boxCapacity: 12,
    palletBoxCapacity: 48,
    unitPrice: "189.00",
    printName: copy.productPrintName,
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
    name: copy.draftProduct,
    printName: copy.draftProductPrintName,
    status: "draft",
    defaultCounterpartyId: null,
    createdAt: "2026-08-24T09:40:00.000Z",
  };
  const ARCHIVED_PRODUCT = {
    ...PRODUCT,
    id: ARCHIVED_PRODUCT_ID,
    gtin14: "04600000000020",
    name: copy.archivedProduct,
    printName: copy.archivedProductPrintName,
    archived: true,
    defaultCounterpartyId: null,
    createdAt: "2026-05-18T11:05:00.000Z",
  };

  const LINE = { id: LINE_ID, name: copy.line, createdAt: "2026-08-01T06:00:00.000Z" };
  const SECOND_LINE = {
    id: SECOND_LINE_ID,
    name: copy.secondLine,
    createdAt: "2026-08-14T06:00:00.000Z",
  };
  const THIRD_LINE = {
    id: THIRD_LINE_ID,
    name: copy.thirdLine,
    createdAt: "2026-08-28T06:00:00.000Z",
  };

  /**
   * `LinesPage` renders the "no stations assigned" line when
   * `assignedStations === 0`, the "online · {{online}} of {{total}}" chip
   * when `onlineStations > 0`, and the offline one otherwise
   * (apps/admin/src/pages/lines/index.tsx:129-148). All three states appear
   * on the `lines-list` frame, because the document names all three.
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
    name: copy.counterparty,
    gln: "4600000000001",
    inn: "7736207543",
    gs1Prefixes: ["0460000"],
    notes: null,
    createdAt: "2026-07-11T08:00:00.000Z",
  };
  const LABEL_TEMPLATE = {
    id: TEMPLATE_ID,
    name: copy.boxLabelTemplate,
    widthMm: 100,
    heightMm: 150,
    dpi: 203,
    language: "zpl",
    updatedAt: "2026-08-20T10:00:00.000Z",
  };
  const SHIFT_PLANNING_CONFIG = { defaultBoxLabelTemplateId: TEMPLATE_ID };

  /**
   * Validated by the strict `productLabelTemplateListSchema`
   * (packages/domain/src/product-labels/contracts.ts:147) -- an extra field
   * throws inside the form instead of rendering.
   */
  const PRODUCT_LABEL_TEMPLATES = {
    items: [
      {
        id: PRODUCT_LABEL_TEMPLATE_ID,
        name: copy.productLabelTemplate,
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
      },
    ],
  };
  const DUPLICATE_PLANNING_CONFIG = {
    defaultBoxLabelTemplateId: TEMPLATE_ID,
    validationPrintProtocol: "validation-dm-duplicate-v1",
  };
  /** Strict `productLabelHistorySchema` (packages/domain/src/product-labels/history.ts:20). */
  const PRODUCT_LABEL_HISTORY = {
    summary: { sentAttempts: 1240, verifiedAttempts: 1238, unresolvedJobs: 1, reprintAttempts: 3 },
    items: [
      {
        jobId: "a0000000-0000-4000-8000-000000000001",
        deviceId: STATION_ID,
        codeSuffix: "…0128",
        acceptedAt: "2026-09-02T11:04:00.000Z",
        status: "completed",
        verificationOutcome: "verified",
        attemptNo: 1,
        ownershipConflict: false,
      },
      {
        jobId: "a0000000-0000-4000-8000-000000000002",
        deviceId: STATION_ID,
        codeSuffix: "…0129",
        acceptedAt: "2026-09-02T11:05:00.000Z",
        status: "attention",
        verificationOutcome: "pending",
        attemptNo: 2,
        ownershipConflict: false,
      },
    ],
    nextCursor: null,
  };

  /** The two people on the floor, named identically everywhere they appear. */
  const PARTICIPANTS = [
    {
      employeeId: "60000000-0000-4000-8000-000000000001",
      fullName: copy.participant,
      role: copy.participantRole,
    },
    {
      employeeId: "60000000-0000-4000-8000-000000000002",
      fullName: copy.secondParticipant,
      role: null,
    },
  ];

  /**
   * `GET /shifts/:id/summary` feeds the details panel's shift-result and
   * participants blocks (`ShiftDetailsPanel.tsx:72,93-142`). Not zod-parsed,
   * so the shape has to mirror `ShiftSummaryDto` field for field: a wrong
   * name renders an empty tile instead of throwing.
   *
   * Built PER SHIFT. The panel and the shift's own list row are printed on
   * the SAME frame, so one shared summary showed a shift the list called
   * planned and empty as having closed 96 boxes with two operators working on
   * it — on a date after its own production date. Here the two named
   * operators always add up to the shift's own `output`, and their activity
   * falls on the shift's own production day.
   */
  function shiftActivity(productionDate: string) {
    const [first, second] = PARTICIPANTS;
    if (!first || !second) throw new Error("Expected two participants");
    return {
      generatedAt: `${productionDate}T11:20:00.000Z`,
      first: {
        ...first,
        firstActivityAt: `${productionDate}T04:15:00.000Z`,
        lastActivityAt: `${productionDate}T11:05:00.000Z`,
      },
      second: {
        ...second,
        firstActivityAt: `${productionDate}T04:20:00.000Z`,
        lastActivityAt: `${productionDate}T10:40:00.000Z`,
      },
      // Four events nobody signed for, which is what raises the panel's
      // "operations with no employee" notice.
      unattributed: { eventCount: 4, acceptedScans: 4, closedBoxes: 0 },
    };
  }
  /** Roughly seven tenths of the work on the first operator, as before. */
  function share(total: number): [number, number] {
    const first = Math.round(total * 0.7);
    return [first, total - first];
  }
  function aggregationSummary(productionDate: string, closedBoxes: number, containedUnits: number) {
    const { generatedAt, first, second, unattributed } = shiftActivity(productionDate);
    const [firstBoxes, secondBoxes] = share(closedBoxes);
    const [firstScans, secondScans] = share(containedUnits);
    return {
      generatedAt,
      output: { mode: "aggregation", closedBoxes, containedUnits },
      participants: [
        { ...first, acceptedScans: firstScans, closedBoxes: firstBoxes },
        { ...second, acceptedScans: secondScans, closedBoxes: secondBoxes },
      ],
      unattributed,
    };
  }
  /** A validation shift closes no boxes, so its people close none either. */
  function validationSummary(productionDate: string, acceptedUnits: number) {
    const { generatedAt, first, second, unattributed } = shiftActivity(productionDate);
    const [firstScans, secondScans] = share(acceptedUnits);
    return {
      generatedAt,
      output: { mode: "validation", acceptedUnits },
      participants: [
        { ...first, acceptedScans: firstScans, closedBoxes: 0 },
        { ...second, acceptedScans: secondScans, closedBoxes: 0 },
      ],
      unattributed: { ...unattributed, closedBoxes: 0 },
    };
  }
  /** Nothing has run: no output, nobody on the shift, nothing unattributed. */
  function plannedSummary(productionDate: string, mode: "aggregation" | "validation") {
    return {
      generatedAt: `${productionDate}T05:40:00.000Z`,
      output:
        mode === "validation"
          ? { mode: "validation", acceptedUnits: 0 }
          : { mode: "aggregation", closedBoxes: 0, containedUnits: 0 },
      participants: [],
      unattributed: { eventCount: 0, acceptedScans: 0, closedBoxes: 0 },
    };
  }

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
    palletBoxCapacity: 48,
    palletsEnabled: true,
    createdFrom: "admin",
    openedAt: null,
    closedAt: null,
    lateDataAt: null,
    closeReason: null,
    createdAt: "2026-08-30T05:40:00.000Z",
    // Actual output so far, added to the list by #474: a planned shift has
    // produced nothing yet, an active one is part-way, a closed one carries
    // its final tally.
    output: { mode: "aggregation", closedBoxes: 0, containedUnits: 0 },
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
    output: { mode: "aggregation", closedBoxes: 153, containedUnits: 1836 },
  };

  const STATION_DEVICE = {
    id: STATION_ID,
    type: "station",
    name: copy.station,
    place: { id: LINE_ID, name: LINE.name },
    status: "online",
    lastSeenAt: "2026-08-30T05:59:00.000Z",
    paired: true,
  };
  const DEVICES_RESPONSE = { items: [STATION_DEVICE], page: 1, pageSize: 20, total: 1 };

  // --- MKR-INS-09 (shift monitoring, closing and reports) fixtures --------

  const ACTIVE_SHIFT_09 = {
    ...ACTIVE_SHIFT,
    id: ACTIVE_SHIFT_09_ID,
    number: "SEP26-004",
    plannedDate: "2026-09-02",
    productionDate: "2026-09-02",
    openedAt: "2026-09-02T04:10:00.000Z",
    createdAt: "2026-09-01T14:00:00.000Z",
    output: { mode: "aggregation", closedBoxes: 96, containedUnits: 1152 },
  };
  const DUPLICATE_SHIFT = {
    ...ACTIVE_SHIFT_09,
    mode: "validation",
    // `assertPalletConfiguration` (apps/api/src/modules/shifts/shifts.service.ts)
    // refuses pallets outside an aggregation shift, and the cabinet's own
    // checkbox lives inside the aggregation section -- so a validation shift
    // can never carry `palletsEnabled`, and its panel has no pallets section.
    palletsEnabled: false,
    output: { mode: "validation", acceptedUnits: 1240 },
    validationPrint: {
      mode: "duplicate_dm",
      templateId: PRODUCT_LABEL_TEMPLATE_ID,
      verification: "required",
      snapshot: { name: copy.productLabelTemplate },
    },
  };
  const CLOSED_SHIFT = {
    ...ACTIVE_SHIFT_09,
    id: CLOSED_SHIFT_ID,
    number: "SEP26-003",
    status: "closed",
    plannedDate: "2026-09-01",
    productionDate: "2026-09-01",
    openedAt: "2026-09-01T04:05:00.000Z",
    closedAt: "2026-09-01T12:40:00.000Z",
    closeReason: copy.closeReason,
    createdAt: "2026-08-31T14:00:00.000Z",
    // The whole-shift report below (`EXPORT_READY`) covers every closed box of
    // this shift, so the shift's own output is what that report totals: a
    // report can never carry fewer codes than the shift closed.
    plannedQty: 900,
    output: { mode: "aggregation", closedBoxes: 74, containedUnits: 888 },
  };
  const LATE_SHIFT = {
    ...CLOSED_SHIFT,
    id: LATE_SHIFT_ID,
    number: "SEP26-002",
    lateDataAt: "2026-09-01T14:05:00.000Z",
  };

  /**
   * Every shift fixture this mock might serve, in one place. `/api/pallets`
   * derives its known-shift whitelist from this list (see `installApi`)
   * instead of a hand-copied id array, so a shift fixture added here cannot
   * silently fall off that whitelist and get a spurious 404.
   */
  const SHIFTS = [
    PLANNED_SHIFT,
    ACTIVE_SHIFT,
    ACTIVE_SHIFT_09,
    DUPLICATE_SHIFT,
    CLOSED_SHIFT,
    LATE_SHIFT,
  ];

  /**
   * One summary per shift, each agreeing with that shift's own row. The
   * duplicate shift shares `ACTIVE_SHIFT_09_ID` but runs in validation mode,
   * and only one of the two is ever served in a given scenario, so it is
   * listed under its own scenario's key below.
   */
  type ShiftSummaryFixture =
    | ReturnType<typeof aggregationSummary>
    | ReturnType<typeof validationSummary>
    | ReturnType<typeof plannedSummary>;
  const SHIFT_SUMMARIES = new Map<string, ShiftSummaryFixture>([
    [SHIFT_ID, plannedSummary(PLANNED_SHIFT.productionDate, "aggregation")],
    [
      ACTIVE_SHIFT_ID,
      aggregationSummary(
        ACTIVE_SHIFT.productionDate,
        ACTIVE_SHIFT.output.closedBoxes,
        ACTIVE_SHIFT.output.containedUnits,
      ),
    ],
    [
      ACTIVE_SHIFT_09_ID,
      aggregationSummary(
        ACTIVE_SHIFT_09.productionDate,
        ACTIVE_SHIFT_09.output.closedBoxes,
        ACTIVE_SHIFT_09.output.containedUnits,
      ),
    ],
    [
      CLOSED_SHIFT_ID,
      aggregationSummary(
        CLOSED_SHIFT.productionDate,
        CLOSED_SHIFT.output.closedBoxes,
        CLOSED_SHIFT.output.containedUnits,
      ),
    ],
    [
      LATE_SHIFT_ID,
      aggregationSummary(
        LATE_SHIFT.productionDate,
        LATE_SHIFT.output.closedBoxes,
        LATE_SHIFT.output.containedUnits,
      ),
    ],
  ]);
  const DUPLICATE_SHIFT_SUMMARY = validationSummary(
    DUPLICATE_SHIFT.productionDate,
    DUPLICATE_SHIFT.output.acceptedUnits,
  );

  /**
   * The pallets of ONE shift, in the three states the panel can show: a plain
   * closed pallet, one whose member box was disassembled after the close, and
   * a dismantled pallet. The placard rule (`ShiftDetailsPanel.tsx:196-198`) is
   * `closedAt !== null && disassembledAt === null && sscc !== null` -- it
   * never looks at `contentsChangedAfterClose`, so the first TWO are
   * printable and only the dismantled third is excluded.
   *
   * The dismantled pallet keeps its counts, and that is the product's
   * behaviour, not a fixture convenience. Dismantling writes ONLY
   * `pallets.disassembledAt` (`apps/api/src/modules/station-scans/pallet-ingest.ts`:
   * "Only the pallet is retired. Its boxes stay closed and keep `pallet_id`"),
   * while `boxCount` / `unitCount` filter on the BOXES' own `disassembledAt`
   * (`apps/api/src/modules/pallets/pallets.service.ts`), never the pallet's.
   * Zeros here would require every member box to have been disassembled --
   * which would in turn force `contentsChangedAfterClose` true, a mark this
   * row does not carry. So a dismantled pallet that held 24 boxes still reads
   * 24 / 288.
   *
   * Counts stay inside what the owning shift actually closed: the smallest
   * shift these fixtures serve closed 74 boxes, and 24 + 23 + 24 = 71 fits
   * under it. A pallet closed short of the 48-box capacity is ordinary (the
   * operator closes it at a changeover or at the end of a run); a shift
   * holding more palletised boxes than it ever closed is not.
   */
  function palletsOfShift(firstSerial: number, productionDate: string) {
    const common = {
      kind: "production" as const,
      productId: PRODUCT_ID,
      productName: PRODUCT.name,
      deviceName: copy.station,
      rejectedMembershipCount: 0,
      terminalId: null,
      lineName: LINE.name,
      operatorId: null,
    };
    return [
      {
        ...common,
        id: palletUuid(firstSerial),
        sscc: palletSscc(firstSerial),
        boxCount: 24,
        unitCount: 288,
        closedAt: `${productionDate}T06:40:00.000Z`,
        contentsChangedAfterClose: false,
        disassembledAt: null,
      },
      {
        ...common,
        id: palletUuid(firstSerial + 1),
        sscc: palletSscc(firstSerial + 1),
        // Closed with 24 boxes; one of them was taken apart afterwards.
        boxCount: 23,
        unitCount: 276,
        closedAt: `${productionDate}T08:55:00.000Z`,
        contentsChangedAfterClose: true,
        disassembledAt: null,
      },
      {
        ...common,
        id: palletUuid(firstSerial + 2),
        sscc: palletSscc(firstSerial + 2),
        boxCount: 24,
        unitCount: 288,
        closedAt: `${productionDate}T09:40:00.000Z`,
        contentsChangedAfterClose: false,
        disassembledAt: `${productionDate}T10:50:00.000Z`,
      },
    ];
  }

  /**
   * `GET /pallets` answers for ONE shift, so every shift fixture owns its own
   * pallets instead of sharing a single list. Serving one list to all of them
   * printed a never-launched shift holding pallets closed the day before its
   * own production date.
   *
   * Built from `SHIFTS` so a shift fixture added later cannot fall off the
   * mock, and keyed by id, so the two fixtures that share `ACTIVE_SHIFT_09_ID`
   * answer identically.
   */
  const PALLETS_BY_SHIFT = new Map<string, ReturnType<typeof palletsOfShift>>();
  let nextPalletSerial = 1;
  for (const shift of SHIFTS) {
    if (PALLETS_BY_SHIFT.has(shift.id)) continue;
    if (shift.status === "planned") {
      // Nothing has been produced yet, so there is nothing on the floor to
      // stack: the section renders its documented "no pallets in this shift"
      // empty state rather than rows from some other shift.
      PALLETS_BY_SHIFT.set(shift.id, []);
      continue;
    }
    // Pallets are closed during the shift that owns them, so their timestamps
    // follow that shift's own production date.
    PALLETS_BY_SHIFT.set(shift.id, palletsOfShift(nextPalletSerial, shift.productionDate));
    nextPalletSerial += 3;
  }

  /**
   * `/api/dashboard/overview` is parsed with a `.strict()` zod schema
   * (apps/admin/src/pages/dashboard/api.ts:71-118), so these fixtures mirror
   * it field for field. Verdict, quality and the shift list must AGREE — a
   * verdict reason with no matching data on the same frame is a fabrication
   * (the same rule the inventory close-preview fixtures follow).
   *
   * "Production is under control": no reasons, one active shift, so the
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
   * "Needs attention" over late data: the reason appears in verdict.reasons,
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
    createdByName: copy.managerFullName,
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
    // The version the catalog advertises today: `export-history.tsx` looks a
    // run's label up by `formatId@formatVersion`, so a run created now carries
    // the current version.
    formatVersion: 2,
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

  return {
    PROFILE,
    PRODUCT,
    DRAFT_PRODUCT,
    ARCHIVED_PRODUCT,
    LINE,
    SECOND_LINE,
    THIRD_LINE,
    LINE_PRESENCE,
    COUNTERPARTY,
    LABEL_TEMPLATE,
    SHIFT_PLANNING_CONFIG,
    PRODUCT_LABEL_TEMPLATES,
    DUPLICATE_PLANNING_CONFIG,
    PRODUCT_LABEL_HISTORY,
    PARTICIPANTS,
    SHIFT_SUMMARIES,
    DUPLICATE_SHIFT_SUMMARY,
    PLANNED_SHIFT,
    ACTIVE_SHIFT,
    STATION_DEVICE,
    DEVICES_RESPONSE,
    ACTIVE_SHIFT_09,
    DUPLICATE_SHIFT,
    CLOSED_SHIFT,
    LATE_SHIFT,
    SHIFTS,
    PALLETS_BY_SHIFT,
    DASHBOARD_UNDER_CONTROL,
    DASHBOARD_ATTENTION,
    EXPORT_READY,
    EXPORT_PROCESSING,
    EXPORT_FAILED,
    EXPORT_STALE,
  };
}

type Fixtures = ReturnType<typeof fixtures>;

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
  | "exportsStale"
  | "shiftDuplicate"
  | "shiftLabels";

/**
 * Every scenario shares the shell fetches (profile, access, pending
 * pickup-order count) and adds only what its screen needs. Anything not
 * matched aborts and is recorded in `unexpected`, so a screen that quietly
 * needs one more endpoint fails the test instead of rendering a
 * false-positive empty state.
 */
async function installApi(page: Page, scenario: Scenario, fx: Fixtures) {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/profile") return json(route, fx.PROFILE);
    if (path === "/api/access/me") {
      return json(route, scenario === "deviceDrawer" ? ACCESS_ADMIN : ACCESS);
    }
    if (path === "/api/pickup-orders") return json(route, PICKUP_ORDERS_EMPTY);
    // The details panel loads the summary for every shift status, and each
    // shift gets ITS OWN: the summary sits on the same frame as the shift's
    // list row, so the two have to tell one story.
    const summaryMatch = /^\/api\/shifts\/([0-9a-f-]+)\/summary$/.exec(path);
    if (summaryMatch?.[1]) {
      // The duplicate shift reuses `ACTIVE_SHIFT_09_ID` with a validation
      // output, so its own scenarios answer with the validation summary.
      const summary =
        scenario === "shiftDuplicate" || scenario === "shiftLabels"
          ? fx.DUPLICATE_SHIFT_SUMMARY
          : fx.SHIFT_SUMMARIES.get(summaryMatch[1]);
      if (summary) return json(route, summary);
      unexpected.push(`${route.request().method()} ${path}${url.search}`);
      return route.abort();
    }
    // `GET /pallets` 404s for an unknown shift rather than returning an empty
    // list, so the panel treats an error as a real failure -- answer each
    // shift with ITS OWN pallets. `fx.PALLETS_BY_SHIFT` covers every shift
    // fixture this mock knows about, so a shift the frames open always has an
    // answer, and an empty list is a real empty list rather than a 404.
    if (path === "/api/pallets") {
      const shiftId = url.searchParams.get("shiftId");
      const pallets = shiftId === null ? undefined : fx.PALLETS_BY_SHIFT.get(shiftId);
      if (pallets !== undefined) return json(route, { items: pallets });
      // A shift with no fixture is a defect in this mock, not a state worth
      // photographing: the panel would draw its red "could not load the
      // pallets" alert and the frame would be written anyway. Record it so
      // the test fails instead of shipping that frame.
      unexpected.push(`${route.request().method()} ${path}${url.search}`);
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }

    if (scenario === "shiftDuplicate" || scenario === "shiftLabels") {
      if (path === "/api/shifts") return json(route, { items: [fx.DUPLICATE_SHIFT] });
      if (path === "/api/products") {
        return json(route, { items: [fx.PRODUCT, fx.DRAFT_PRODUCT, fx.ARCHIVED_PRODUCT] });
      }
      if (path === "/api/lines") {
        return json(route, { items: [fx.LINE, fx.SECOND_LINE, fx.THIRD_LINE] });
      }
      if (path === "/api/counterparties") return json(route, { items: [fx.COUNTERPARTY] });
      if (path === "/api/label-templates") return json(route, { items: [fx.LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") {
        return json(route, fx.DUPLICATE_PLANNING_CONFIG);
      }
      if (path === "/api/shifts/product-label-templates") {
        return json(route, fx.PRODUCT_LABEL_TEMPLATES);
      }
      if (/^\/api\/shifts\/[0-9a-f-]+\/product-labels$/.test(path)) {
        return json(route, fx.PRODUCT_LABEL_HISTORY);
      }
      if (path === "/api/operators") {
        return json(route, {
          items: fx.PARTICIPANTS.map(({ employeeId, fullName }) => ({ employeeId, fullName })),
        });
      }
    }
    // Only the admin shell reaches this one: the badge is gated on
    // `billing.read`, which the manager role does not carry.
    if (scenario === "deviceDrawer" && path === "/api/billing/attention") {
      return json(route, { count: 0 });
    }

    if (scenario === "lines" || scenario === "linesDeleteBlocked") {
      if (path === "/api/lines") {
        return json(route, { items: [fx.LINE, fx.SECOND_LINE, fx.THIRD_LINE] });
      }
      if (path === "/api/lines/presence") return json(route, { items: fx.LINE_PRESENCE });
      if (scenario === "linesDeleteBlocked" && path === `/api/lines/${LINE_ID}`) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "LINE_REFERENCED" }),
        });
      }
    }

    if (scenario === "devices" || scenario === "deviceDrawer") {
      if (path === "/api/devices") return json(route, fx.DEVICES_RESPONSE);
      if (path === "/api/device-licensing") {
        return json(route, {
          tenantId: "11111111-1111-4111-8111-111111111111",
          usage: 1,
          limit: 3,
          canCancelReservations: true,
          integrity: "ready",
          devices: [
            {
              deviceId: fx.STATION_DEVICE.id,
              name: fx.STATION_DEVICE.name,
              kind: "station",
              assignmentId: "22222222-2222-4222-8222-222222222222",
              revision: 1,
              state: "assigned",
              releaseReason: null,
              slotOccupied: true,
              canCancel: false,
              blockedReason: "already_paired",
              connectionStatus: "online",
              pairedAt: "2026-08-20T08:00:00.000Z",
              lastSeenAt: "2026-08-20T10:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/device-licensing/replacements") {
        return json(route, { canPrepare: false, items: [] });
      }
      if (path === "/api/device-licensing/retention") {
        return json(route, {
          canSelect: false,
          observation: null,
          selections: [],
          currentShadow: { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
        });
      }
      // The add-device drawer offers the line select, so it loads the lines.
      if (path === "/api/lines") {
        return json(route, { items: [fx.LINE, fx.SECOND_LINE, fx.THIRD_LINE] });
      }
    }

    if (
      scenario === "shiftsList" ||
      scenario === "shiftCreate" ||
      scenario === "shiftsPlanned" ||
      scenario === "shiftActiveEdit"
    ) {
      if (path === "/api/shifts") {
        return json(route, {
          items:
            scenario === "shiftsPlanned" ? [fx.PLANNED_SHIFT, fx.ACTIVE_SHIFT] : [fx.ACTIVE_SHIFT],
        });
      }
      if (path === "/api/products") {
        return json(route, { items: [fx.PRODUCT, fx.DRAFT_PRODUCT, fx.ARCHIVED_PRODUCT] });
      }
      if (path === "/api/lines") {
        return json(route, { items: [fx.LINE, fx.SECOND_LINE, fx.THIRD_LINE] });
      }
      if (path === "/api/counterparties") return json(route, { items: [fx.COUNTERPARTY] });
      if (path === "/api/label-templates") return json(route, { items: [fx.LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") return json(route, fx.SHIFT_PLANNING_CONFIG);
    }

    if (scenario === "dashboardCalm" || scenario === "dashboardAttention") {
      if (path === "/api/dashboard/overview") {
        return json(
          route,
          scenario === "dashboardCalm" ? fx.DASHBOARD_UNDER_CONTROL : fx.DASHBOARD_ATTENTION,
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
              ? [fx.ACTIVE_SHIFT_09]
              : scenario === "shiftsLate"
                ? [fx.ACTIVE_SHIFT_09, fx.LATE_SHIFT, fx.CLOSED_SHIFT]
                : [fx.CLOSED_SHIFT],
        });
      }
      // The shifts page loads the planning references regardless of what the
      // frame is about -- same set the 08 scenarios serve.
      if (path === "/api/products") {
        return json(route, { items: [fx.PRODUCT, fx.DRAFT_PRODUCT, fx.ARCHIVED_PRODUCT] });
      }
      if (path === "/api/lines") {
        return json(route, { items: [fx.LINE, fx.SECOND_LINE, fx.THIRD_LINE] });
      }
      if (path === "/api/counterparties") return json(route, { items: [fx.COUNTERPARTY] });
      if (path === "/api/label-templates") return json(route, { items: [fx.LABEL_TEMPLATE] });
      if (path === "/api/shifts/planning-config") return json(route, fx.SHIFT_PLANNING_CONFIG);
    }
    if (exportScenario) {
      if (path === "/api/shift-exports/formats") return json(route, SHIFT_EXPORT_FORMATS_FIXTURE);
      if (path === `/api/shifts/${CLOSED_SHIFT_ID}/exports`) {
        return json(
          route,
          scenario === "exportsCatalog"
            ? []
            : scenario === "exportsHistory"
              ? [fx.EXPORT_PROCESSING, fx.EXPORT_READY]
              : scenario === "exportsFailed"
                ? [fx.EXPORT_FAILED]
                : [fx.EXPORT_STALE],
        );
      }
    }

    unexpected.push(`${route.request().method()} ${path}${url.search}`);
    return route.abort();
  });
  return unexpected;
}

/**
 * Every row action moved into the details panel (`e177cea30`, 2026-09-02):
 * the list now carries only the "details" button. Tests that used to click an
 * action in the row open the panel first.
 */
async function openShiftDetails(page: Page, t: Translate, shiftNumber: string) {
  await page
    .getByRole("row", { name: new RegExp(shiftNumber) })
    .getByRole("button", { name: t("pages.shifts.details.action") })
    .click();
  await expect(
    page.getByRole("heading", { name: t("pages.shifts.details.title", { number: shiftNumber }) }),
  ).toBeVisible();
}

/**
 * `?locale=` is what the harness feeds to `i18n.changeLanguage` before the
 * first paint (apps/admin/test/browser/cabinet-harness.tsx), so the frame is
 * rendered in that language from the very first frame instead of flashing
 * the default one.
 */
async function openHarness(page: Page, locale: AdminLocale, route: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/test/browser/production.html?route=${encodeURIComponent(route)}&locale=${locale}`,
  );
}

for (const locale of LOCALES) {
  const { t } = adminI18n(locale);

  const shot = (name: string) => screenshotPath(locale, name);
  const shot09 = (name: string) => screenshotPath09(locale, name);

  test(`lines list shows all three presence states (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "lines", fx);
    await openHarness(page, locale, "/lines");
    await expect(page.getByText(t("pages.lines.title"))).toBeVisible();
    await expect(
      page.getByText(t("pages.lines.presence.online", { online: 2, total: 3 })),
    ).toBeVisible();
    await expect(page.getByText(t("pages.lines.presence.offline"))).toBeVisible();
    await expect(page.getByText(t("pages.lines.presence.unassigned"))).toBeVisible();
    await screenshotFullMain(page, shot("lines-list"));
    expect(unexpected).toEqual([]);
  });

  test(`line form (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "lines", fx);
    await openHarness(page, locale, "/lines/new");
    await expect(page.getByText(t("pages.lines.form.createTitle"))).toBeVisible();
    await screenshotFullMain(page, shot("line-form"));
    expect(unexpected).toEqual([]);
  });

  test(`deleting a referenced line is refused (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "linesDeleteBlocked", fx);
    await openHarness(page, locale, "/lines");
    await page
      .getByRole("button", { name: t("pages.lines.delete") })
      .first()
      .click();
    await page
      .getByRole("button", { name: t("pages.lines.deleteConfirmAction"), exact: true })
      .last()
      .click();
    await expect(
      page.getByText(t("pages.lines.deleteReferencedError"), { exact: false }),
    ).toBeVisible();
    await screenshotFullMain(page, shot("line-delete-blocked"));
    expect(unexpected).toEqual([]);
  });

  /**
   * The devices LIST shows the line under the "place" column, not a "line"
   * one -- the line label with its explanatory hint lives in the device's own
   * drawer (`DeviceDrawer.tsx:316-320`). Both frames exist so the document
   * can name each string against the screen that actually shows it.
   */
  test(`device list shows its line under the place column (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "devices", fx);
    await openHarness(page, locale, "/devices");
    await expect(page.getByText(fx.STATION_DEVICE.name)).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: t("pages.devices.table.place"), exact: true }),
    ).toBeVisible();
    await screenshotFullMain(page, shot("device-list"));
    expect(unexpected).toEqual([]);
  });

  test(`device workspace remains usable on a narrow screen (${locale})`, async ({ page }, info) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "deviceDrawer", fx);
    await openHarness(page, locale, "/devices");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("region", { name: t("pages.devices.overview.label") }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: t("pages.devices.registry.label") }),
    ).toBeVisible();
    await expect(page.getByText(t("pages.devices.workflows.title"))).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
    await settle(page);
    await page.screenshot({
      path: info.outputPath(`device-workspace-${locale}-390.png`),
      fullPage: true,
    });
    expect(unexpected).toEqual([]);
  });

  test(`device drawer assigns the line (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "deviceDrawer", fx);
    await openHarness(page, locale, "/devices");
    await page.getByRole("button", { name: t("pages.devices.add") }).click();
    await expect(page.getByText(t("pages.devices.lineHint"), { exact: false })).toBeVisible();
    await screenshotFullMain(page, shot("device-line"));
    expect(unexpected).toEqual([]);
  });

  test(`shifts list before planning (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsList", fx);
    await openHarness(page, locale, "/shifts");
    await expect(page.getByText("AUG26-002")).toBeVisible();
    await screenshotFullMain(page, shot("shifts-list"));
    expect(unexpected).toEqual([]);
  });

  /**
   * A draft or archived product is listed but NOT selectable: `ShiftForm.tsx`
   * builds each option with `disabled: product.archived || product.status ===
   * "draft"` (:286) and appends the draft / archived hint to the label
   * (:281-285). This is the opposite of the inventory form, where an archived
   * product is deliberately selectable -- hence its own frame, so the printed
   * claim rests on a picture.
   */
  test(`shift form: draft and archived products are listed but disabled (${locale})`, async ({
    page,
  }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftCreate", fx);
    await openHarness(page, locale, "/shifts/new");
    await page.getByRole("combobox", { name: t("pages.shifts.form.productLabel") }).click();
    await expect(page.getByText(t("pages.shifts.form.draftHint"))).toBeVisible();
    await expect(page.getByText(t("pages.shifts.form.archivedHint"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-product-options"));
    expect(unexpected).toEqual([]);
  });

  /**
   * Picking a product prefills the counterparty and the capacities from that
   * product's defaults (`ShiftForm.tsx:205,221-234`), which is a frequent
   * "why did this appear?" question -- so the frame shows the form after the
   * choice, not an empty one.
   */
  test(`shift form: choosing a product prefills the counterparty (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftCreate", fx);
    await openHarness(page, locale, "/shifts/new");
    await page.getByRole("combobox", { name: t("pages.shifts.form.productLabel") }).click();
    await page.getByRole("option", { name: fx.PRODUCT.name, exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: t("pages.shifts.form.counterpartyLabel") }),
    ).toHaveText(fx.COUNTERPARTY.name);
    await screenshotFullMain(page, shot("shift-filled"));
    expect(unexpected).toEqual([]);
  });

  /**
   * The aggregation section only renders while `shiftMode === "aggregation"`
   * (`ShiftForm.tsx:536`), and a new form starts in "validation" (form
   * defaults, :101). So the capacities and pallet fields genuinely do not
   * exist until the manager picks the mode. Shot after the product is chosen
   * too, so the prefilled capacities (12 / 48 from the product) are visible.
   */
  test(`shift form: templates and aggregation (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftCreate", fx);
    await openHarness(page, locale, "/shifts/new");
    await page.getByRole("combobox", { name: t("pages.shifts.form.productLabel") }).click();
    await page.getByRole("option", { name: fx.PRODUCT.name, exact: true }).click();
    await page.getByRole("radio", { name: t("pages.shifts.form.modeAggregation") }).check();
    await expect(page.getByText(t("pages.shifts.form.palletsEnabledLabel"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-aggregation"));
    expect(unexpected).toEqual([]);
  });

  /**
   * `palletsEnabledLabel` names the checkbox itself and is visible as soon as
   * aggregation mode is picked (see the frame above), but the capacity and
   * template fields it gates only mount once that checkbox is actually
   * checked (`ShiftForm.tsx:938-956`). So the planning instruction's pallet
   * frame follows the same product-then-mode order as the aggregation frame
   * and then checks the box before shooting the fields it unlocks.
   */
  test(`shift planning shows the pallet fields (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftCreate", fx);
    await openHarness(page, locale, "/shifts/new");
    await page.getByRole("combobox", { name: t("pages.shifts.form.productLabel") }).click();
    await page.getByRole("option", { name: fx.PRODUCT.name, exact: true }).click();
    await page.getByRole("radio", { name: t("pages.shifts.form.modeAggregation") }).check();
    await expect(page.getByText(t("pages.shifts.form.palletsEnabledLabel"))).toBeVisible();
    await page.getByRole("checkbox", { name: t("pages.shifts.form.palletsEnabledLabel") }).check();
    await expect(page.getByLabel(t("pages.shifts.form.palletBoxCapacityLabel"))).toBeVisible();
    await expect(page.getByText(t("pages.shifts.form.palletLabelTemplateLabel"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-pallets"));
    expect(unexpected).toEqual([]);
  });

  test(`shifts list after planning (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsPlanned", fx);
    await openHarness(page, locale, "/shifts");
    await expect(page.getByText("AUG26-003")).toBeVisible();
    await expect(page.getByText(t("pages.shifts.status.planned"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-planned"));
    expect(unexpected).toEqual([]);
  });

  /**
   * While a shift is active the form locks everything except the planned
   * quantity and the two dates (`ShiftForm.tsx`'s `activeEdit` flag disables
   * product, mode, line, counterparty, SSCC issuer, template and capacities).
   */
  test(`an active shift locks most of its form (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftActiveEdit", fx);
    await openHarness(page, locale, `/shifts/${ACTIVE_SHIFT_ID}/edit`);
    await expect(page.getByText(`${t("pages.shifts.form.editTitle")} · AUG26-002`)).toBeVisible();
    await screenshotFullMain(page, shot("shift-active-locked"));
    expect(unexpected).toEqual([]);
  });

  /**
   * Submitting ANY edit of an active shift routes through the confirmation
   * instead of persisting: `ShiftPanelRoute.tsx:254-258` sets `criticalInput`
   * whenever `shift.status === "active"`, which opens the critical-change
   * dialog.
   */
  test(`saving an active shift asks for confirmation (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftActiveEdit", fx);
    await openHarness(page, locale, `/shifts/${ACTIVE_SHIFT_ID}/edit`);
    await page.getByLabel(t("pages.shifts.form.plannedQtyLabel")).fill("5200");
    await page.getByRole("button", { name: t("pages.shifts.form.submitUpdate") }).click();
    await expect(page.getByText(t("pages.shifts.activeEdit.title"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-active-edit"));
    expect(unexpected).toEqual([]);
  });

  test(`deleting a planned shift asks for confirmation (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsPlanned", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "AUG26-003");
    await page.getByRole("button", { name: t("pages.shifts.delete") }).click();
    await expect(page.getByText(t("pages.shifts.deleteConfirmTitle"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-delete"));
    expect(unexpected).toEqual([]);
  });

  // --- MKR-INS-09 frames ---------------------------------------------------

  test(`dashboard: production under control (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "dashboardCalm", fx);
    await openHarness(page, locale, "/");
    await expect(page.getByText(t("pages.dashboard.verdict.status.under_control"))).toBeVisible();
    await expect(page.getByText(t("pages.dashboard.verdict.noReasons"))).toBeVisible();
    await screenshotFullMain(page, shot09("dashboard-under-control"));
    expect(unexpected).toEqual([]);
  });

  test(`dashboard: keeps the content scroll rail inside the viewport (${locale})`, async ({
    page,
  }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "dashboardCalm", fx);
    await openHarness(page, locale, "/");
    await page.setViewportSize({ width: 1512, height: 809 });
    await expect(page.getByText(t("pages.dashboard.verdict.status.under_control"))).toBeVisible();

    const layout = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".mk-app-shell");
      const content = document.querySelector<HTMLElement>(".mk-app-shell__content");
      const main = content?.querySelector<HTMLElement>("main");
      const scrollingElement = document.scrollingElement;
      if (!shell || !content || !main || !scrollingElement) {
        throw new Error("Expected the complete admin shell");
      }

      main.scrollTop = main.scrollHeight;

      return {
        documentOverflow: scrollingElement.scrollHeight - scrollingElement.clientHeight,
        shellBottom: Math.round(shell.getBoundingClientRect().bottom),
        contentBottom: Math.round(content.getBoundingClientRect().bottom),
        mainBottom: Math.round(main.getBoundingClientRect().bottom),
        mainScrolled: main.scrollTop > 0,
        viewportHeight: window.innerHeight,
        windowScrollY: window.scrollY,
      };
    });

    expect(layout).toEqual({
      documentOverflow: 0,
      shellBottom: 809,
      contentBottom: 809,
      mainBottom: 809,
      mainScrolled: true,
      viewportHeight: 809,
      windowScrollY: 0,
    });
    expect(unexpected).toEqual([]);
  });

  test(`dashboard: needs attention over late data (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "dashboardAttention", fx);
    await openHarness(page, locale, "/");
    await expect(page.getByText(t("pages.dashboard.verdict.status.needs_attention"))).toBeVisible();
    await expect(
      page.getByText(t("pages.dashboard.verdict.reason.late_data_one", { count: 1 })),
    ).toBeVisible();
    await screenshotFullMain(page, shot09("dashboard-attention"));
    expect(unexpected).toEqual([]);
  });

  test(`the details panel of an active shift offers the close action (${locale})`, async ({
    page,
  }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsClose", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-004");
    await expect(
      page.getByRole("heading", { name: t("pages.shifts.details.actionsTitle") }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: t("pages.shifts.close") })).toBeVisible();
    await screenshotFullMain(page, shot09("shifts-active"));
    expect(unexpected).toEqual([]);
  });

  /**
   * The pallets section only renders while `shift.palletsEnabled`
   * (`ShiftDetailsPanel.tsx:499`), which every SHIFTS fixture now carries, and
   * it holds all three states `PALLETS` exercises: a plain closed pallet, one
   * whose contents changed after close, and a disassembled one
   * (`ShiftDetailsPanel.tsx:196-198,250-255`). Shot as its own section rather
   * than a full-page frame: the panel is very tall and a full capture would
   * just repeat `shifts-active`.
   */
  test(`the shift panel lists the pallets of the shift (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsClose", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-004");
    // `Table` gives its own horizontal-scroll wrapper the same accessible
    // name via `scrollLabel`, so two "region"s share this name -- `.first()`
    // is the outer `<section>` (it wraps the table, so it is first in
    // document order), not the inner scroll container.
    const pallets = page.getByRole("region", { name: t("pages.shifts.pallets.title") }).first();
    await expect(pallets).toBeVisible();
    await expect(page.getByText(t("pages.shifts.pallets.disassembled"))).toBeVisible();
    await expect(page.getByText(t("pages.shifts.pallets.contentsChangedAfterClose"))).toBeVisible();
    await settle(page);
    await pallets.screenshot({ path: shot09("shift-pallets"), scale: "css" });
    expect(unexpected).toEqual([]);
  });

  /**
   * The "Ярлыки" action only appears once some pallet is closed, still
   * standing and carries an SSCC (`ShiftDetailsPanel.tsx:196-198`) -- two of
   * the three `PALLETS` fixtures qualify, so SEP26-004 (same shift as the
   * pallets list frame above) offers it.
   */
  test(`the pallet placard dialog offers its formats (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsClose", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-004");
    await page.getByRole("button", { name: t("pages.shifts.pallets.placards.action") }).click();
    await expect(
      page.getByRole("dialog", { name: t("pages.shifts.pallets.placards.title") }),
    ).toBeVisible();
    await screenshotFullMain(page, shot09("pallet-placards"));
    expect(unexpected).toEqual([]);
  });

  test(`closing a shift from the cabinet asks for a reason (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsClose", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-004");
    await page.getByRole("button", { name: t("pages.shifts.close") }).click();
    await expect(page.getByText(t("pages.shifts.closeModal.reasonLabel"))).toBeVisible();
    await screenshotFullMain(page, shot09("shift-close"));
    expect(unexpected).toEqual([]);
  });

  test(`late data badge on a closed shift (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftsLate", fx);
    await openHarness(page, locale, "/shifts");
    await expect(page.getByText(t("pages.shifts.table.lateData"))).toBeVisible();
    await screenshotFullMain(page, shot09("shifts-late-badge"));
    expect(unexpected).toEqual([]);
  });

  /**
   * The report dialog only exists on CLOSED shifts (`ShiftExportAction` renders
   * for `row.status === "closed"`, apps/admin/src/pages/shifts/index.tsx:372),
   * so every export frame starts from CLOSED_SHIFT's row.
   */
  test(`shift reports: format catalog and split controls (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "exportsCatalog", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-003");
    // Domain string: `SHIFT_EXPORT_FORMATS` hardcodes the format labels in
    // Russian, so the cabinet shows them untranslated in either locale.
    await expect(page.getByText("[XML][ГИСМТ] Отчет об агрегации")).toBeVisible();
    await expect(page.getByText(t("pages.shifts.exports.splitLabel"))).toBeVisible();
    await screenshotFullMain(page, shot09("exports-catalog"));
    expect(unexpected).toEqual([]);
  });

  test(`shift reports: history with ready parts and a processing run (${locale})`, async ({
    page,
  }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "exportsHistory", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-003");
    await expect(
      page.getByText(t("pages.shifts.exports.status.ready"), { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(t("pages.shifts.exports.status.processing"))).toBeVisible();
    await expect(page.getByText(t("pages.shifts.exports.part", { number: 1 }))).toBeVisible();
    await screenshotFullMain(page, shot09("exports-history"));
    expect(unexpected).toEqual([]);
  });

  test(`shift reports: failed run explains itself and offers a retry (${locale})`, async ({
    page,
  }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "exportsFailed", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-003");
    await expect(
      page.getByText(t("pages.shifts.exports.errors.BOX_COVERAGE_INCOMPLETE")),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: t("pages.shifts.exports.retry") })).toBeVisible();
    await screenshotFullMain(page, shot09("exports-failed"));
    expect(unexpected).toEqual([]);
  });

  test(`shift reports: stale run warns after late data (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "exportsStale", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-003");
    await expect(page.getByText(t("pages.shifts.exports.stale"))).toBeVisible();
    await screenshotFullMain(page, shot09("exports-stale"));
    expect(unexpected).toEqual([]);
  });

  /**
   * Validation shifts can now duplicate the product's Data Matrix onto the
   * outer packaging (`728863928`). The option only unlocks when planning-config
   * reports the protocol, and it replaces the templates section with the
   * duplicate-print one -- both facts the printed instruction has to state.
   */
  test(`planning a validation shift offers the Data Matrix duplicate (${locale})`, async ({
    page,
  }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftDuplicate", fx);
    await openHarness(page, locale, "/shifts/new");
    await page.getByRole("combobox", { name: t("pages.shifts.form.productLabel") }).click();
    await page.getByRole("option", { name: fx.PRODUCT.name, exact: true }).click();
    await page.getByRole("radio", { name: t("pages.shifts.form.modeValidation") }).check();
    await page.getByRole("radio", { name: t("pages.shifts.duplicate.on") }).check();
    await expect(page.getByText(t("pages.shifts.duplicate.template"))).toBeVisible();
    await expect(page.getByText(t("pages.shifts.duplicate.verification"))).toBeVisible();
    await screenshotFullMain(page, shot("shift-duplicate-print"));
    expect(unexpected).toEqual([]);
  });

  test(`the details panel lists duplicate label attempts (${locale})`, async ({ page }) => {
    const fx = fixtures(locale);
    const unexpected = await installApi(page, "shiftLabels", fx);
    await openHarness(page, locale, "/shifts");
    await openShiftDetails(page, t, "SEP26-004");
    await expect(
      page.getByRole("heading", { name: t("pages.shifts.productLabels.title") }),
    ).toBeVisible();
    await screenshotFullMain(page, shot09("shift-labels-history"));
    expect(unexpected).toEqual([]);
  });
}
