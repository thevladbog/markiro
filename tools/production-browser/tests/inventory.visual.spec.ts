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

/**
 * MKR-INS-07 (printed inventory-closing instruction) screenshot targets --
 * the post-launch half of the lifecycle, same "Марка Ко" organisation and
 * line as MKR-INS-06, but its own INVENTORY-26-0043 inventory rather than
 * MKR-INS-06's ИНВ-000042. It has to be a *repack* inventory, not a
 * reuse of MKR-INS-06's check-mode one: this document's corrections and
 * closing screens depict repack-box actions (invalidate, reprint) and an
 * open/closed box count that feeds close blockers, and check-mode
 * inventories reject repack events outright
 * (`station-inventory-sync.service.ts`'s `INVENTORY_EVENT_MODE_MISMATCH`)
 * and never populate `inventory_repack_boxes`
 * (`inventory-reconciliation.service.ts`) -- a check-mode inventory could
 * never actually reach the states these frames show.
 */
const SCREENSHOT_DIR_07 = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-07",
);
function screenshotPath07(name: string): string {
  return join(SCREENSHOT_DIR_07, `${name}.png`);
}

/**
 * `AppShell` pins the shell to `height: 100vh; overflow: hidden` and scrolls
 * internally inside `<main>` (see the `exports` screenshot's comment further
 * down for the full explanation), so a screenshot at a fixed 1280x800
 * viewport silently crops anything below the fold instead of failing the
 * test. Several MKR-INS-07 screens stack more content than 800px allows
 * (the live progress page; the documents card once catalog/history/
 * completion sections all render) -- this reuses the exports screenshot's
 * technique instead of inventing another one: grow the viewport by `main`'s
 * actual overflow, then capture. A no-op when the page already fits.
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

/**
 * MKR-INS-07 fixtures. Same organisation/inventory as above, now past
 * launch: `InventoryDetailPage` (InventoryDetailPage.tsx) hands off to
 * `InventoryLivePage` for any of `running`/`closed`/`completed`, which reads
 * its own status from `GET /inventories/:id/progress`
 * (`useInventoryProgress`) rather than from the outer detail fetch -- both
 * are mocked to agree below. `InventoryLivePage` unconditionally mounts
 * `InventoryDocuments`, so every post-launch scenario (including the ones
 * that never touch documents) must also answer `/inventory-document-formats`
 * and `/inventories/:id/document-runs`.
 */
const DEVICE_ID_1 = "80000000-0000-4000-8000-000000000001";
const DEVICE_ID_2 = "80000000-0000-4000-8000-000000000002";
const BOX_ID_1 = "90000000-0000-4000-8000-000000000001";
const BOX_ID_2 = "90000000-0000-4000-8000-000000000002";
const BOX_ID_3 = "90000000-0000-4000-8000-000000000003";
const EVENT_ID_1 = "a0000000-0000-4000-8000-000000000001";
const EVENT_ID_2 = "a0000000-0000-4000-8000-000000000002";
const EVENT_ID_3 = "a0000000-0000-4000-8000-000000000003";
const EVENT_ID_4 = "a0000000-0000-4000-8000-000000000004";
const CODE_RESULT_ID_1 = "b0000000-0000-4000-8000-000000000001";
const CODE_RESULT_ID_2 = "b0000000-0000-4000-8000-000000000002";
const CODE_RESULT_ID_3 = "b0000000-0000-4000-8000-000000000003";

/**
 * Scan identities exactly as the API hands them to the cabinet. Both event
 * endpoints run the retained `raw_payload` through
 * `formatInventoryEventIdentity` (`inventory-event-display.ts`) before
 * answering, so `displayIdentity` is the GS1 human-readable pair, never the
 * stored `normalized_identity` (`item:<64 hex>` / `old_box:<sscc>`) that the
 * column still holds for matching. `InventoryLivePage.tsx` /
 * `InventoryCorrections.tsx` print that string verbatim inside
 * `.mk-inventory-mono`.
 *
 * The KMs behind them are the three of «Сироп «Клюква», 0.5 л» this document's
 * frames follow -- `010460000000000621000123` / `...000512` / `...000456` --
 * split by `canonicalizeKm` into AI 01 (GTIN-14) and AI 21 (serial) exactly as
 * `(01)<gtin14> (21)<serial>`.
 */
const ITEM_IDENTITY_1 = "(01)04600000000006 (21)000123";
const ITEM_IDENTITY_2 = "(01)04600000000006 (21)000512";
const ITEM_IDENTITY_3 = "(01)04600000000006 (21)000456";
/**
 * The old box Терминал 2 opened to start repacking. An `old_box` event carries
 * the *source* box's SSCC (`applyRepackMutation` stores it as the new box's
 * `old_sscc_context`), which is a different physical box from the repack box
 * the cabinet lists under «Новые короба» -- that panel shows `new_sscc`. Valid
 * GS1 check digit, since a scan with a bad one never becomes an event
 * (`parseScannedSscc` -> `isValidSscc`), and rendered through `formatSsccHri`
 * like every other SSCC the API hands out.
 */
const OLD_BOX_IDENTITY = "(00)046012345600000016";
const LATE_EVENT_ID_1 = "c0000000-0000-4000-8000-000000000001";
const LATE_EVENT_ID_2 = "c0000000-0000-4000-8000-000000000002";
const DOC_RUN_FIRST_ID = "d0000000-0000-4000-8000-000000000002";
const DOC_RUN_SECOND_ID = "d0000000-0000-4000-8000-000000000001";
const ARTIFACT_FIRST_STOCK_ID = "e0000000-0000-4000-8000-000000000001";
const ARTIFACT_SECOND_STOCK_ID = "e0000000-0000-4000-8000-000000000002";
const ARTIFACT_SECOND_WRITE_OFF_ID = "e0000000-0000-4000-8000-000000000003";

/**
 * MKR-INS-07's own inventory -- deliberately *not* a reuse of MKR-INS-06's
 * `inventoryRow`/`INVENTORY_ID`/`activeSnapshot` (those stay untouched so
 * MKR-INS-06's eight PNGs stay byte-identical). `mode: "repack"` plus a
 * non-null `boxLabelTemplate` are required together by
 * `validateInventoryResponseSemantics` (schemas.ts) for any repack-mode
 * inventory.
 */
const INVENTORY_ID_07 = "51000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID_07 = "61000000-0000-4000-8000-000000000001";

/**
 * `formatInventoryNumber` (apps/api/src/modules/inventories/inventory-number.ts)
 * is the only producer of `inventories.number`, and it emits
 * `INVENTORY-YY-NNNN`: the two-digit UTC year of creation plus the zero-padded
 * per-tenant sequence. This inventory is created 2026-08-28 (`createdAt`
 * below) as the tenant's 43rd, so `INVENTORY-26-0043` is literally what the
 * API would have written for it.
 */
const inventoryRow07 = {
  id: INVENTORY_ID_07,
  number: "INVENTORY-26-0043",
  status: "preparing",
  mode: "repack",
  productId: PRODUCT_ID,
  gtin14: "04600000000006",
  productName: "Сироп «Клюква», 0.5 л",
  lineId: LINE_ID,
  lineName: "Линия 1",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  boxLabelTemplateId: TEMPLATE_ID,
  boxLabelTemplate: { id: TEMPLATE_ID, name: "Короб 100×150" },
  activeSnapshotId: null,
  resultRevision: 0,
  createdAt: "2026-08-28T09:00:00.000Z",
  updatedAt: "2026-08-28T09:00:00.000Z",
};

/**
 * Same shape as MKR-INS-06's `activeSnapshot`, re-keyed to this inventory and
 * re-scaled to the size this document's frames depict -- reads the old one
 * (never mutates it) so MKR-INS-06's fixtures stay untouched. The counts have
 * to be small: `station-inventory-sync.service.ts` (`validateAndExpand`)
 * forces every *eligible* item scan in repack mode to be an `add-item`, and
 * `applyRepackMutation` caps a box at the product's `boxCapacity` (12 here),
 * so an inventory with N verified codes necessarily has ceil(N/12) repack
 * boxes. A 116-code snapshot would mean ten boxes in the "Короба" card;
 * 24 expected codes are exactly the two-then-three boxes these frames show.
 * `expected` is `introduced ∩ applied` minus `protected`, as in MKR-INS-06.
 */
const activeSnapshot07 = {
  ...activeSnapshot,
  id: SNAPSHOT_ID_07,
  inventoryId: INVENTORY_ID_07,
  counts: {
    ...activeSnapshot.counts,
    introduced: 26,
    applied: 26,
    expected: 24,
    packages: 2,
    loose: 4,
  },
};

/**
 * Detail-level counters (`inventories.service.ts`: `activeParticipantCount` is
 * every participant row with `left_at is null`, the rest are sums of the same
 * live state the progress payload reports). Not rendered by
 * `InventoryLivePage`, but they travel in the same frame's detail response, so
 * each post-launch scenario passes the tally that matches its own progress.
 */
const RUNNING_BLOCKERS = {
  activeParticipantCount: 2,
  pendingEventCount: 3,
  participantOpenBoxCount: 1,
  openRepackBoxCount: 1,
  unresolvedPrintBoxCount: 0,
};
const RUNNING_BLOCKERS_BLOCKED = {
  activeParticipantCount: 2,
  pendingEventCount: 3,
  participantOpenBoxCount: 2,
  openRepackBoxCount: 2,
  unresolvedPrintBoxCount: 0,
};

/** Shared by every post-launch detail fetch: a fixed snapshot always exists once an inventory is running (see the `terminals` scenario's comment above -- "ready" is the only status that carries a freshly fixed snapshot, and running/closed/completed all come after it). */
function postLaunchInventoryDetail(
  status: "running" | "closed" | "completed",
  blockers: typeof EMPTY_BLOCKERS = EMPTY_BLOCKERS,
) {
  return {
    ...inventoryRow07,
    status,
    activeSnapshotId: SNAPSHOT_ID_07,
    activeSnapshot: activeSnapshot07,
    blockers,
    imports: readyImports,
    resultRevision: 1,
  };
}

const RUNNING_DETAIL = postLaunchInventoryDetail("running", RUNNING_BLOCKERS);
const RUNNING_DETAIL_BLOCKED = postLaunchInventoryDetail("running", RUNNING_BLOCKERS_BLOCKED);
/** Everyone has left the task and every box is closed -- the only state a zero-blocker close preview can describe. */
const RUNNING_DETAIL_READY = postLaunchInventoryDetail("running");
const CLOSED_DETAIL = postLaunchInventoryDetail("closed");

/**
 * Two real formats from `INVENTORY_DOCUMENT_FORMATS`
 * (packages/domain/src/inventory/documents.ts) that don't require an
 * organisation ИНН, keeping the mock catalog free of that extra gate.
 */
const DOCUMENT_FORMATS = [
  {
    id: "inventory_csv_current_stock",
    version: 1,
    label: "[CSV] Коды на учёт",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    requiredSourceCategories: ["verified", "protected"],
    supportsParts: false,
    availability: "available",
  },
  {
    id: "inventory_txt_write_off",
    version: 1,
    label: "[TXT] Коды к списанию",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    requiredSourceCategories: ["writeOffCandidates", "protected"],
    supportsParts: false,
    availability: "available",
  },
];
const DOCUMENT_FORMATS_RESPONSE = { items: DOCUMENT_FORMATS };
const NO_DOCUMENT_RUNS = { items: [] };

/**
 * Repack boxes shared by every post-launch progress payload below. Box states
 * are never invented per frame: `inventory-close.service.ts` counts open boxes
 * (`OPEN_REPACK_BOX`), invalidated ones (`INVALIDATED_REPACK_BOX`) and closed
 * ones that are not `printed` (`UNRESOLVED_BOX_PRINT`), so a frame's box list
 * and its close preview are two views of the same tally. `printState` follows
 * the real lifecycle in `station-inventory-sync.service.ts`: `not_ready` while
 * the box is open, `pending` the moment it closes, `printed` once the label
 * came out. `itemCount` never exceeds the product's `boxCapacity` (12) --
 * `applyRepackMutation` closes a box at capacity and rejects anything past it.
 *
 * Every `sscc` below ends in the GS1 mod-10 check digit of its own first 17
 * digits (`gs1CheckDigit`, packages/domain/src/gs1/check-digit.ts). A repack
 * box only ever gets its SSCC from `buildSscc`, and a scanned one has to pass
 * `parseScannedSscc` -> `isValidSscc`, so a box whose check digit is wrong
 * cannot exist in any inventory.
 */
const BOX_1_BASE = {
  id: BOX_ID_1,
  sscc: "123456789012345675",
  terminalId: DEVICE_ID_1,
  terminalName: "Терминал 1",
  productionDate: "2026-08-15",
} as const;
const BOX_2_BASE = {
  id: BOX_ID_2,
  sscc: "223456789012345672",
  terminalId: DEVICE_ID_2,
  terminalName: "Терминал 2",
  productionDate: "2026-08-16",
} as const;
const BOX_3_BASE = {
  id: BOX_ID_3,
  sscc: "323456789012345679",
  terminalId: DEVICE_ID_2,
  terminalName: "Терминал 2",
  productionDate: "2026-08-16",
} as const;
interface RepackBoxBase {
  readonly id: string;
  readonly sscc: string;
  readonly terminalId: string;
  readonly terminalName: string;
  readonly productionDate: string;
}
function openBox(base: RepackBoxBase, itemCount: number) {
  return { ...base, state: "open", printState: "not_ready", itemCount };
}
function closedBox(base: RepackBoxBase, itemCount: number) {
  return { ...base, state: "closed", printState: "printed", itemCount };
}
/**
 * Still running, nobody has attempted to close yet: Терминал 1 is filling its
 * box, Терминал 2 has already closed and printed a full one. Backs
 * `live`/`corrections`; the closed+printed box is also what makes the
 * "Поставить перепечать в очередь" action render at all (`CorrectionBox`
 * shows it only for `closed` + `printed`).
 */
const BOXES_RUNNING = [openBox(BOX_1_BASE, 7), closedBox(BOX_2_BASE, 12)];
/**
 * A close attempt while both terminals still hold an open box -- Терминал 2
 * opened a second one after closing its first. Matches
 * `CLOSE_PREVIEW_BLOCKED`'s `OPEN_REPACK_BOX` count of 2 exactly. The API
 * orders open boxes first, newest first, then closed ones.
 */
const BOXES_BLOCKED = [openBox(BOX_3_BASE, 0), openBox(BOX_1_BASE, 7), closedBox(BOX_2_BASE, 12)];
/** Every box closed and printed -- the only box state a close preview with zero blockers can describe. Backs `closePreviewReady` and every `closed`-status screen (late events, documents, completion, reopen). */
const BOXES_CLOSED = [
  closedBox(BOX_3_BASE, 4),
  closedBox(BOX_2_BASE, 12),
  closedBox(BOX_1_BASE, 7),
];

const PARTICIPANT_1_BASE = {
  deviceId: DEVICE_ID_1,
  terminalName: "Терминал 1",
  operatorName: "Мария Кузнецова",
  joinedAt: "2026-08-29T08:00:00.000Z",
} as const;
const PARTICIPANT_2_BASE = {
  deviceId: DEVICE_ID_2,
  terminalName: "Терминал 2",
  operatorName: "Пётр Смирнов",
  joinedAt: "2026-08-29T08:05:00.000Z",
} as const;
/**
 * Both terminals still in the task: one heartbeating (`active`), one past the
 * 45-second window `inventory-close.service.ts` uses to split
 * `ACTIVE_PARTICIPANT` from `STALE_PARTICIPANT`, still holding three unsynced
 * events (`PENDING_OUTBOX`). `openBoxCount` is each terminal's own report and
 * feeds `PARTICIPANT_OPEN_BOX`, so it tracks that frame's box list.
 */
const PARTICIPANTS_WORKING = [
  {
    ...PARTICIPANT_1_BASE,
    leftAt: null,
    heartbeatAt: "2026-08-29T09:58:00.000Z",
    state: "active",
    pendingEventCount: 0,
    openBoxCount: 1,
  },
  {
    ...PARTICIPANT_2_BASE,
    leftAt: null,
    heartbeatAt: "2026-08-29T09:40:00.000Z",
    state: "stale",
    pendingEventCount: 3,
    openBoxCount: 0,
  },
];
/** Same two terminals at the moment of the blocked close attempt: Терминал 2 now reports the second box it opened. */
const PARTICIPANTS_WORKING_BOTH_OPEN = [
  PARTICIPANTS_WORKING[0],
  { ...PARTICIPANTS_WORKING[1], openBoxCount: 1 },
];
/**
 * Both operators have left the task. The participant rows survive with
 * `left_at` set (the progress query keeps them and labels them `left`), and
 * the close-blocker query ignores them entirely (`where left_at is null`), so
 * this is what "no terminal blockers" actually looks like.
 */
const PARTICIPANTS_LEFT = [
  {
    ...PARTICIPANT_1_BASE,
    leftAt: "2026-08-29T10:12:00.000Z",
    heartbeatAt: "2026-08-29T10:12:00.000Z",
    state: "left",
    pendingEventCount: 0,
    openBoxCount: 0,
  },
  {
    ...PARTICIPANT_2_BASE,
    leftAt: "2026-08-29T10:15:00.000Z",
    heartbeatAt: "2026-08-29T10:15:00.000Z",
    state: "left",
    pendingEventCount: 0,
    openBoxCount: 0,
  },
];

/**
 * The three newest scan events while corrections are still open. Each one is
 * also an `EVIDENCE_RESPONSE` row (same event ids, same classifications):
 * both endpoints read `inventory_scan_events` left-joined to
 * `inventory_code_results`, so a code result exists exactly when
 * `codeResultId` is set, and `classification` comes from that same row.
 * `authoritativeVerdict` is `applied` for every accepted event
 * (`station-inventory-sync.service.ts`).
 */
const RECENT_EVENTS_RUNNING = [
  {
    eventId: EVENT_ID_1,
    codeResultId: CODE_RESULT_ID_1,
    kind: "item",
    displayIdentity: ITEM_IDENTITY_1,
    authoritativeVerdict: "applied",
    terminalId: DEVICE_ID_1,
    terminalName: "Терминал 1",
    scannedAt: "2026-08-29T09:55:00.000Z",
    classification: "protected",
    observedProductionDate: "2026-08-20",
  },
  {
    eventId: EVENT_ID_4,
    codeResultId: CODE_RESULT_ID_3,
    kind: "item",
    displayIdentity: ITEM_IDENTITY_2,
    authoritativeVerdict: "applied",
    terminalId: DEVICE_ID_1,
    terminalName: "Терминал 1",
    scannedAt: "2026-08-29T09:50:00.000Z",
    classification: "expected",
    observedProductionDate: "2026-08-15",
  },
  {
    eventId: EVENT_ID_2,
    codeResultId: CODE_RESULT_ID_2,
    kind: "item",
    displayIdentity: ITEM_IDENTITY_3,
    authoritativeVerdict: "applied",
    terminalId: DEVICE_ID_2,
    terminalName: "Терминал 2",
    scannedAt: "2026-08-29T09:20:00.000Z",
    classification: "voided",
    observedProductionDate: "2026-08-16",
  },
];
/**
 * The same three events after the corrections section has been worked
 * through: the protected code's observed date now matches the ЧЗ date (so the
 * `date_mismatch` discrepancy is gone) and the voided scan was restored to its
 * origin classification (`inventory-corrections.service.ts`'s `restore_scan`
 * writes back `originClassification`). Nothing else can clear those two
 * counters, and both must be zero before a close preview may report no
 * blockers at all.
 */
const RECENT_EVENTS_RESOLVED = [
  { ...RECENT_EVENTS_RUNNING[0], observedProductionDate: "2026-08-15" },
  RECENT_EVENTS_RUNNING[1],
  { ...RECENT_EVENTS_RUNNING[2], classification: "expected" },
];

/**
 * Progress payload for the plain `running` screens (live progress,
 * corrections) where nobody has attempted to close yet, so an open box is
 * unremarkable. Every counter is tied to the others the way the API derives
 * them (`inventory-reconciliation.service.ts`): `expectedCount` is the
 * snapshot's expected set (24), and an expected code is either verified, or
 * still missing, or voided -- 18 + 5 + 1 = 24. `verifiedCount` also equals the
 * codes sitting in repack boxes (6 + 12; the seventh item in box 1 is the
 * voided one), because repack mode boxes every eligible scan. "Расхождения"
 * on the page is `ineligible + unknown + dateMismatch`, here two protected
 * codes scanned with a production date that differs from the ЧЗ one.
 */
const RUNNING_PROGRESS = {
  inventoryId: INVENTORY_ID_07,
  snapshotId: SNAPSHOT_ID_07,
  status: "running",
  resultRevision: 1,
  expectedCount: 24,
  verifiedCount: 18,
  missingCount: 5,
  protectedCount: 2,
  protectedFoundCount: 2,
  ineligibleCount: 0,
  unknownCount: 0,
  dateMismatchCount: 2,
  voidedCount: 1,
  oldBoxCount: 1,
  newBoxCount: 2,
  invalidatedBoxCount: 0,
  pendingEventCount: 3,
  openBoxCount: 1,
  boxTotal: 2,
  boxesTruncated: false,
  participants: PARTICIPANTS_WORKING,
  boxes: BOXES_RUNNING,
  recentEvents: RECENT_EVENTS_RUNNING,
};

/**
 * Progress payload behind the close-preview modal once it reports zero
 * blockers. `inventory-close.service.ts` derives that list from exactly this
 * state, so *all* of it has to be clean at once: nobody left in the task, no
 * unsynced events, every box closed and printed, and no unresolved
 * discrepancy of any category (`unknown`, `ineligible`, `date_mismatch`,
 * `voided`). Four more codes were packed into the last box in the meantime, so
 * 23 verified + 1 missing still add up to the 24 expected. Backs
 * `closePreviewReady`.
 */
const RUNNING_PROGRESS_READY = {
  ...RUNNING_PROGRESS,
  verifiedCount: 23,
  missingCount: 1,
  dateMismatchCount: 0,
  voidedCount: 0,
  newBoxCount: 3,
  boxTotal: 3,
  pendingEventCount: 0,
  openBoxCount: 0,
  participants: PARTICIPANTS_LEFT,
  boxes: BOXES_CLOSED,
  recentEvents: RECENT_EVENTS_RESOLVED,
};

/**
 * Progress payload behind the blocked close preview: the corrections from
 * section 3 are done (no discrepancy blockers left), but both terminals are
 * still in the task, Терминал 2's queue has not drained and two boxes are
 * open. `CLOSE_PREVIEW_BLOCKED` below is the literal derivation of this
 * state. The restored scan is now verified (18 + 1), so 19 + 5 = 24.
 * Backs `closePreviewBlocked`.
 */
const RUNNING_PROGRESS_BLOCKED = {
  ...RUNNING_PROGRESS,
  verifiedCount: 19,
  dateMismatchCount: 0,
  voidedCount: 0,
  newBoxCount: 3,
  boxTotal: 3,
  openBoxCount: 2,
  participants: PARTICIPANTS_WORKING_BOTH_OPEN,
  boxes: BOXES_BLOCKED,
  recentEvents: RECENT_EVENTS_RESOLVED,
};

/** Progress payload for the `closed` screens (late events, documents, completion, reopen) -- the state the ready preview described, now fixed as the closed result. */
const CLOSED_PROGRESS = { ...RUNNING_PROGRESS_READY, status: "closed" };

/**
 * Evidence events behind the corrections screen. The `actions` array is not
 * free-form: `parseEvidenceEventRow`
 * (apps/api/src/modules/inventories/inventory-reconciliation.service.ts)
 * derives it from the event itself -- no code result means no actions, a
 * voided result means only `restore_scan`, a result whose code sits in an open
 * box means `void_scan` + `remove_item`, a result in no active box means
 * `void_scan` + `change_date`, and one in a closed box means `void_scan`
 * alone. These four rows are one of each, which is also what the printed
 * instruction says about the buttons depending on the row's state.
 */
const EVIDENCE_RESPONSE = {
  page: 1,
  pageSize: 50,
  total: 4,
  hasMore: false,
  items: [
    {
      ...RECENT_EVENTS_RUNNING[0],
      actions: ["void_scan", "change_date"],
    },
    {
      ...RECENT_EVENTS_RUNNING[1],
      actions: ["void_scan", "remove_item"],
    },
    {
      ...RECENT_EVENTS_RUNNING[2],
      actions: ["restore_scan"],
    },
    {
      eventId: EVENT_ID_3,
      codeResultId: null,
      kind: "old_box",
      displayIdentity: OLD_BOX_IDENTITY,
      authoritativeVerdict: "applied",
      terminalId: DEVICE_ID_2,
      terminalName: "Терминал 2",
      scannedAt: "2026-08-29T09:10:00.000Z",
      classification: null,
      observedProductionDate: null,
      actions: [],
    },
  ],
};

const CLOSE_PREVIEW_READY = {
  inventoryId: INVENTORY_ID_07,
  status: "running",
  resultRevision: 1,
  blockers: [],
};

/**
 * The honest derivation of `RUNNING_PROGRESS_BLOCKED`: one active and one
 * stale participant, their three unsynced events, the two open boxes they
 * report and the two open boxes the server itself counts. `BLOCKER_KEYS`
 * (InventoryClosePanel.tsx) renders them as "Активные терминалы: 1",
 * "Терминалы без связи: 1", "Несинхронизированные события: 3", "Открытые
 * короба по данным терминалов: 2" and "Открытые короба: 2". The API never
 * fills `participantId`/`deviceId`/`boxId` for these aggregate counts
 * (`blocker()` in inventory-close.service.ts defaults them all to null).
 */
const CLOSE_PREVIEW_BLOCKED = {
  inventoryId: INVENTORY_ID_07,
  status: "running",
  resultRevision: 1,
  blockers: [
    {
      code: "ACTIVE_PARTICIPANT",
      count: 1,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
    {
      code: "STALE_PARTICIPANT",
      count: 1,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
    {
      code: "PENDING_OUTBOX",
      count: 3,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
    {
      code: "PARTICIPANT_OPEN_BOX",
      count: 2,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
    {
      code: "OPEN_REPACK_BOX",
      count: 2,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
  ],
};

/**
 * Two late-events batches, both still pending a decision, closed inventory
 * (`canDiscard`). Both come from terminals the reader has already met on the
 * live and closing frames -- Терминал 2 is the one whose queue was behind all
 * along, Терминал 1 lost the answer to its last upload.
 */
const LATE_EVENTS_RESPONSE = {
  page: 1,
  pageSize: 50,
  total: 2,
  hasMore: false,
  items: [
    {
      id: LATE_EVENT_ID_1,
      batchId: "batch-2026-08-29-01",
      deviceId: DEVICE_ID_2,
      terminalName: "Терминал 2",
      eventCount: 6,
      receivedAt: "2026-08-29T21:10:00.000Z",
      closedRevision: 1,
      reason: "STATION_OFFLINE",
      resolution: "pending",
      resolvedAt: null,
      replayAvailable: false,
    },
    {
      id: LATE_EVENT_ID_2,
      batchId: "batch-2026-08-29-02",
      deviceId: DEVICE_ID_1,
      terminalName: "Терминал 1",
      eventCount: 2,
      receivedAt: "2026-08-29T21:40:00.000Z",
      closedRevision: 1,
      reason: "NETWORK_TIMEOUT",
      resolution: "pending",
      resolvedAt: null,
      replayAvailable: false,
    },
  ],
};

/**
 * Artifact counters come straight from the generators in
 * packages/domain/src/inventory/tabular-document-generators.ts: the current
 * stock CSV writes one header row plus one row per verified code (23 here, the
 * closed result's `verifiedCount`) and reports no boxes at all, while the
 * write-off TXT lists the expected codes that were never scanned (the single
 * missing one). Filenames come from `inventoryDocumentFilenamePrefix`, which
 * keeps the inventory number's letters and digits.
 */
const CURRENT_STOCK_ARTIFACT = {
  formatId: "inventory_csv_current_stock",
  formatVersion: 1,
  partNumber: 1,
  filename: "inventory-INVENTORY-26-0043-current-stock.csv",
  mimeType: "text/csv; charset=utf-8",
  rowCount: 24,
  codeCount: 23,
  boxCount: 0,
  byteSize: 856,
  sha256: DIGEST,
  invalidatedAt: null,
} as const;
const WRITE_OFF_ARTIFACT = {
  formatId: "inventory_txt_write_off",
  formatVersion: 1,
  partNumber: 1,
  filename: "inventory-INVENTORY-26-0043-write-off.txt",
  mimeType: "text/plain; charset=utf-8",
  rowCount: 1,
  codeCount: 1,
  boxCount: 0,
  byteSize: 37,
  sha256: DIGEST,
  invalidatedAt: null,
} as const;

/** The first run: one format, finished, its file not downloaded yet. Present on both documents frames -- a run history only ever grows. */
const DOCUMENT_RUN_FIRST = {
  id: DOC_RUN_FIRST_ID,
  inventoryId: INVENTORY_ID_07,
  resultRevision: 1,
  selectedFormats: [{ id: "inventory_csv_current_stock", version: 1 }],
  status: "ready",
  errorCode: null,
  sourceSnapshotStartedAt: "2026-08-29T21:50:00.000Z",
  sourceSnapshotCompletedAt: "2026-08-29T21:52:00.000Z",
  completedAt: "2026-08-29T21:52:00.000Z",
  attemptCount: 1,
  createdAt: "2026-08-29T21:50:00.000Z",
  artifacts: [{ ...CURRENT_STOCK_ARTIFACT, id: ARTIFACT_FIRST_STOCK_ID, downloadedAt: null }],
};

/** The second run, both formats, caught mid-generation. Backs `documents-history.png`: `currentRunActive` is true, so the completion section stays blocked while it works. */
const DOCUMENT_RUNS_HISTORY = {
  items: [
    {
      id: DOC_RUN_SECOND_ID,
      inventoryId: INVENTORY_ID_07,
      resultRevision: 1,
      selectedFormats: [
        { id: "inventory_csv_current_stock", version: 1 },
        { id: "inventory_txt_write_off", version: 1 },
      ],
      status: "processing",
      errorCode: null,
      sourceSnapshotStartedAt: "2026-08-29T22:05:00.000Z",
      sourceSnapshotCompletedAt: null,
      completedAt: null,
      attemptCount: 1,
      createdAt: "2026-08-29T22:05:00.000Z",
      artifacts: [],
    },
    DOCUMENT_RUN_FIRST,
  ],
};

/**
 * The same two runs a few minutes later: the second one finished and both of
 * its files were downloaded, which is what `currentArtifactsReady` checks (the
 * newest ready run at the current revision, every artifact non-invalidated and
 * downloaded). Backs `completion.png`.
 */
const DOCUMENT_RUNS_COMPLETE = {
  items: [
    {
      ...DOCUMENT_RUNS_HISTORY.items[0],
      status: "ready",
      sourceSnapshotCompletedAt: "2026-08-29T22:07:00.000Z",
      completedAt: "2026-08-29T22:07:00.000Z",
      artifacts: [
        {
          ...CURRENT_STOCK_ARTIFACT,
          id: ARTIFACT_SECOND_STOCK_ID,
          downloadedAt: "2026-08-29T22:12:00.000Z",
        },
        {
          ...WRITE_OFF_ARTIFACT,
          id: ARTIFACT_SECOND_WRITE_OFF_ID,
          downloadedAt: "2026-08-29T22:12:00.000Z",
        },
      ],
    },
    DOCUMENT_RUN_FIRST,
  ],
};

type Scenario =
  | "list"
  | "create"
  | "exports"
  | "exportsBlocked"
  | "snapshot"
  | "terminals"
  | "live"
  | "corrections"
  | "closePreviewReady"
  | "closePreviewBlocked"
  | "closedLate"
  | "closedDocumentsCatalog"
  | "closedDocumentsHistory"
  | "closedCompletion";

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

    // MKR-INS-07: post-launch screens. `InventoryDetailPage` hands off to
    // `InventoryLivePage` once the detail fetch reports running/closed --
    // that page then drives its own status from `/progress`, so both must
    // agree (see `postLaunchInventoryDetail` above).
    const RUNNING_SCENARIOS: Scenario[] = [
      "live",
      "corrections",
      "closePreviewReady",
      "closePreviewBlocked",
    ];
    const CLOSED_SCENARIOS: Scenario[] = [
      "closedLate",
      "closedDocumentsCatalog",
      "closedDocumentsHistory",
      "closedCompletion",
    ];
    if (RUNNING_SCENARIOS.includes(scenario) && path === `/api/inventories/${INVENTORY_ID_07}`) {
      // The detail response carries its own live tallies, so each running
      // scenario answers with the ones matching its own progress payload.
      return json(
        route,
        scenario === "closePreviewReady"
          ? RUNNING_DETAIL_READY
          : scenario === "closePreviewBlocked"
            ? RUNNING_DETAIL_BLOCKED
            : RUNNING_DETAIL,
      );
    }
    if (CLOSED_SCENARIOS.includes(scenario) && path === `/api/inventories/${INVENTORY_ID_07}`) {
      return json(route, CLOSED_DETAIL);
    }
    // Each "running" scenario gets its own box states (see `BOXES_ONE_OPEN`/
    // `BOXES_ALL_CLOSED`/`BOXES_ALL_OPEN` above) so the boxes shown always
    // agree with what that scenario's own close-preview (if any) claims.
    if (
      (scenario === "live" || scenario === "corrections") &&
      path === `/api/inventories/${INVENTORY_ID_07}/progress`
    ) {
      return json(route, RUNNING_PROGRESS);
    }
    if (
      scenario === "closePreviewReady" &&
      path === `/api/inventories/${INVENTORY_ID_07}/progress`
    ) {
      return json(route, RUNNING_PROGRESS_READY);
    }
    if (
      scenario === "closePreviewBlocked" &&
      path === `/api/inventories/${INVENTORY_ID_07}/progress`
    ) {
      return json(route, RUNNING_PROGRESS_BLOCKED);
    }
    if (
      CLOSED_SCENARIOS.includes(scenario) &&
      path === `/api/inventories/${INVENTORY_ID_07}/progress`
    ) {
      return json(route, CLOSED_PROGRESS);
    }
    // `InventoryLivePage` always mounts `InventoryDocuments`, even on
    // screens that aren't about documents at all (live, the closing modal,
    // late events) -- so every one of those needs the catalog/history
    // endpoints answered, not just the three documents-specific scenarios.
    if (
      (RUNNING_SCENARIOS.includes(scenario) ||
        scenario === "closedLate" ||
        scenario === "closedDocumentsCatalog") &&
      path === "/api/inventory-document-formats"
    ) {
      return json(route, DOCUMENT_FORMATS_RESPONSE);
    }
    if (
      (RUNNING_SCENARIOS.includes(scenario) ||
        scenario === "closedLate" ||
        scenario === "closedDocumentsCatalog") &&
      path === `/api/inventories/${INVENTORY_ID_07}/document-runs`
    ) {
      return json(route, NO_DOCUMENT_RUNS);
    }
    if (scenario === "closedDocumentsHistory" && path === "/api/inventory-document-formats") {
      return json(route, DOCUMENT_FORMATS_RESPONSE);
    }
    if (
      scenario === "closedDocumentsHistory" &&
      path === `/api/inventories/${INVENTORY_ID_07}/document-runs`
    ) {
      return json(route, DOCUMENT_RUNS_HISTORY);
    }
    if (scenario === "closedCompletion" && path === "/api/inventory-document-formats") {
      return json(route, DOCUMENT_FORMATS_RESPONSE);
    }
    if (
      scenario === "closedCompletion" &&
      path === `/api/inventories/${INVENTORY_ID_07}/document-runs`
    ) {
      return json(route, DOCUMENT_RUNS_COMPLETE);
    }
    if (scenario === "corrections" && path === `/api/inventories/${INVENTORY_ID_07}/evidence`) {
      return json(route, EVIDENCE_RESPONSE);
    }
    if (
      scenario === "closePreviewReady" &&
      path === `/api/inventories/${INVENTORY_ID_07}/close-preview`
    ) {
      return json(route, CLOSE_PREVIEW_READY);
    }
    if (
      scenario === "closePreviewBlocked" &&
      path === `/api/inventories/${INVENTORY_ID_07}/close-preview`
    ) {
      return json(route, CLOSE_PREVIEW_BLOCKED);
    }
    if (scenario === "closedLate" && path === `/api/inventories/${INVENTORY_ID_07}/late-events`) {
      return json(route, LATE_EVENTS_RESPONSE);
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
  // at that taller size captures all six cards. `screenshotFullMain` (top of
  // file) implements exactly this and is reused by several MKR-INS-07
  // screenshots below -- this is the one MKR-INS-06 screenshot that needs it.
  await screenshotFullMain(page, screenshotPath("exports"));
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

// --- MKR-INS-07 (post-launch: progress, corrections, closing, late events,
// documents, completion, reopen) -------------------------------------------

test("renders the live progress of a running inventory", async ({ page }) => {
  const unexpected = await installApi(page, "live");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await expect(page.getByRole("heading", { level: 1, name: "INVENTORY-26-0043" })).toBeVisible();
  await expect(page.getByText("Ожидается", { exact: true })).toBeVisible();
  await expect(page.getByText("Проверено", { exact: true })).toBeVisible();
  await expect(page.getByText("Не найдено", { exact: true })).toBeVisible();
  // Exact match: the running-hint paragraph in the closing card below also
  // contains the lowercase substring "расхождения"
  // ("...обязательные расхождения"), and `getByText` matching is
  // case-insensitive by default.
  await expect(page.getByText("Расхождения", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Участники" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Короба" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Последние события" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await screenshotFullMain(page, screenshotPath07("live"));
});

test("renders the corrections list with its filters", async ({ page }) => {
  const unexpected = await installApi(page, "corrections");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}/corrections`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Исправления · INVENTORY-26-0043" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "События сканирования" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Новые короба" })).toBeVisible();
  await expect(page.getByLabel("Тип события")).toBeVisible();
  await expect(page.getByLabel("Классификация")).toBeVisible();
  await expect(page.getByText(ITEM_IDENTITY_1)).toBeVisible();
  expect(unexpected).toEqual([]);
  await screenshotFullMain(page, screenshotPath07("corrections-list"));
});

test("renders the correction form for a selected item", async ({ page }) => {
  const unexpected = await installApi(page, "corrections");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}/corrections`);
  // `CorrectionEvent` (InventoryCorrections.tsx) overrides the *first*
  // action button's accessible name with "Выбрать {identity}" for
  // screen-reader clarity, so its visible text ("Отменить скан") is no
  // longer the accessible name -- match on visible text here instead of
  // role name. Two of the four evidence rows lead with that button, hence
  // `first()`.
  await expect(page.getByText("Отменить скан").first()).toBeVisible();
  // Clicking "Изменить дату" (the second action, no aria-label override) on
  // the first evidence event opens the correction form for that action
  // (InventoryCorrections.tsx's `select`) -- a purely local state change, no
  // network call.
  await page.getByRole("button", { name: "Изменить дату" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: `Исправление · ${ITEM_IDENTITY_1}` }),
  ).toBeVisible();
  await expect(page.getByLabel("Причина исправления")).toBeVisible();
  await expect(page.getByLabel("Новая дата производства")).toBeVisible();
  await expect(page.getByText("Восстановить скан")).toBeVisible();
  expect(unexpected).toEqual([]);
  await screenshotFullMain(page, screenshotPath07("corrections-form"));
});

test("renders the close preview with no blockers", async ({ page }) => {
  const unexpected = await installApi(page, "closePreviewReady");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await page.getByRole("button", { name: "Закрыть инвентаризацию" }).click();
  await expect(page.getByText("Проверка перед закрытием")).toBeVisible();
  await expect(
    page.getByText("Блокировок нет. Результат будет зафиксирован в текущей ревизии."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Закрыть безопасно" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath07("close-ready"), scale: "css" });
});

test("renders the close preview with active blockers", async ({ page }) => {
  const unexpected = await installApi(page, "closePreviewBlocked");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await page.getByRole("button", { name: "Закрыть инвентаризацию" }).click();
  await expect(
    page.getByText(
      "Безопасное закрытие недоступно. Устраните блокировки или зафиксируйте аварийное решение.",
    ),
  ).toBeVisible();
  // Every line the API would derive from this frame's own participants and
  // boxes (see `CLOSE_PREVIEW_BLOCKED`).
  await expect(page.getByText("Активные терминалы: 1")).toBeVisible();
  await expect(page.getByText("Терминалы без связи: 1")).toBeVisible();
  await expect(page.getByText("Несинхронизированные события: 3")).toBeVisible();
  await expect(page.getByText("Открытые короба по данным терминалов: 2")).toBeVisible();
  await expect(page.getByText("Открытые короба: 2")).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath07("close-blocked"), scale: "css" });
});

test("renders the emergency-close form once blockers are acknowledged", async ({ page }) => {
  // Same blocked preview as `close-blocked` -- `InventoryClosePanel.tsx`
  // shows the emergency reason field, the acknowledgement checkbox and the
  // "Закрыть аварийно" button in the very same modal state as soon as
  // `blockers.length > 0`; there is no separate "emergency mode" to switch
  // into. What distinguishes this screenshot is filling the form in (never
  // submitting it -- that would need `/emergency-close` mocked, which this
  // scenario deliberately doesn't do).
  const unexpected = await installApi(page, "closePreviewBlocked");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await page.getByRole("button", { name: "Закрыть инвентаризацию" }).click();
  await expect(page.getByText("Активные терминалы: 1")).toBeVisible();
  await page
    .getByLabel("Причина аварийного закрытия")
    .fill("Обрыв связи со складом, партия зафиксирована по факту пересчёта.");
  await page
    .getByRole("checkbox", {
      name: "Я понимаю, что блокировки останутся в зафиксированном результате",
    })
    .check();
  await expect(page.getByRole("button", { name: "Закрыть аварийно" })).toBeEnabled();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath07("close-emergency"), scale: "css" });
});

test("renders late events awaiting a decision", async ({ page }) => {
  // Continuity note: this scenario uses the `closed` status (matching the
  // late-events/documents/completion group below), not `running`. That
  // makes `InventoryLateEvents.tsx`'s `canDiscard` branch (status ===
  // "closed") reachable, which is what shows "Причина решения" and
  // "Исключить выбранные" -- but that same status makes the per-event
  // "Повторить обработку" button unreachable, since it only renders when
  // `inventoryStatus === "running"` (line ~160). The two cannot appear in
  // the same screenshot: closed unlocks discarding, running unlocks
  // replaying, and an inventory has exactly one status.
  const unexpected = await installApi(page, "closedLate");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await page.getByRole("button", { name: "Поздние события" }).click();
  await expect(page.getByText("batch-2026-08-29-01")).toBeVisible();
  await expect(page.getByText("6 событий")).toBeVisible();
  await page.getByRole("checkbox", { name: "Выбрать пакет batch-2026-08-29-01" }).check();
  await page
    .getByLabel("Причина решения")
    .fill("Пакет пришёл после закрытия по регламенту, короба уже пересчитаны вручную.");
  await expect(page.getByRole("button", { name: "Исключить выбранные" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath07("late-events"), scale: "css" });
});

test("renders the document catalog before any run exists", async ({ page }) => {
  const unexpected = await installApi(page, "closedDocumentsCatalog");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await expect(page.getByRole("heading", { level: 2, name: "Итоговые документы" })).toBeVisible();
  await expect(page.getByText("Что сформировать")).toBeVisible();
  await expect(page.getByText("[CSV] Коды на учёт · CSV · v1")).toBeVisible();
  await expect(page.getByText("[TXT] Коды к списанию · TXT · v1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сформировать документы" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await screenshotFullMain(page, screenshotPath07("documents-catalog"));
});

test("renders the document generation history", async ({ page }) => {
  const unexpected = await installApi(page, "closedDocumentsHistory");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await expect(page.getByRole("heading", { level: 3, name: "История формирования" })).toBeVisible();
  await expect(page.getByText("Готово")).toBeVisible();
  await expect(page.getByText("Формируется")).toBeVisible();
  await expect(page.getByRole("button", { name: "Скачать ZIP" })).toBeVisible();
  await expect(page.getByText("кодов: 23", { exact: false })).toBeVisible();
  expect(unexpected).toEqual([]);
  await screenshotFullMain(page, screenshotPath07("documents-history"));
});

test("renders the completion step once documents are downloaded", async ({ page }) => {
  const unexpected = await installApi(page, "closedCompletion");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await expect(page.getByRole("heading", { level: 3, name: "Завершение" })).toBeVisible();
  // Both runs from the history frame are still here, now finished -- a run
  // history never loses entries between two moments of the same result.
  await expect(page.getByRole("button", { name: "Скачать ZIP" })).toHaveCount(2);
  await expect(page.getByText("Итоговые документы скачаны и проверены")).toBeVisible();
  await page.getByRole("checkbox", { name: "Итоговые документы скачаны и проверены" }).check();
  await expect(page.getByRole("button", { name: "Завершить инвентаризацию" })).toBeEnabled();
  expect(unexpected).toEqual([]);
  await screenshotFullMain(page, screenshotPath07("completion"));
});

test("renders the reopen confirmation dialog", async ({ page }) => {
  const unexpected = await installApi(page, "closedDocumentsCatalog");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/inventory.html?route=/inventory/${INVENTORY_ID_07}`);
  await page.getByRole("button", { name: "Возобновить" }).click();
  await expect(page.getByText("Возобновить инвентаризацию?")).toBeVisible();
  // `pages.inventory.close.reopenExplanation` verbatim (ru.json) -- section 7
  // of MKR-INS-07 restates all four consequences this alert lists, so the
  // frame has to actually carry them rather than an older paraphrase.
  await expect(
    page.getByText(
      "Ревизия результата увеличится, отметки о закрытии будут сняты, уже сформированные итоговые документы аннулируются и станут недоступны для скачивания — после повторного закрытия их придётся сформировать заново, а ожидающие поздние события снова можно будет обработать.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить возобновление" })).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: screenshotPath07("reopen"), scale: "css" });
});
