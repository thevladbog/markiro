import codeRegistryFixture from "../../../proto/fixtures/code-registry-page.json";
import counterpartyFixture from "../../../proto/fixtures/counterparty-record.json";
import deviceFixture from "../../../proto/fixtures/device-record.json";
import networkFixture from "../../../proto/fixtures/host-network.json";
import lineFixture from "../../../proto/fixtures/office-line.json";
import productFixture from "../../../proto/fixtures/office-product.json";
import shiftFixture from "../../../proto/fixtures/office-shift.json";
import userFixture from "../../../proto/fixtures/office-user.json";
import palletFixture from "../../../proto/fixtures/office-warehouse-pallet-detail.json";
import orgFixture from "../../../proto/fixtures/org-profile.json";
import templateFixture from "../../../proto/fixtures/template-summary.json";
import exportSettingsFixture from "../../../proto/fixtures/export-settings.json";
import { createHostApi } from "../../../src/host/api.js";
import type { HostClient } from "../../../src/host/client.js";
import { officeSearchRequestSchema } from "../../../src/host/office-search.js";
import {
  officeProductSchema,
  officeShiftSchema,
  officeUserSchema,
} from "../../../src/host/protocol.js";
import { ACTIVE_LICENSE } from "../../support/license.js";
import { HEALTHY_BACKUPS, backupCopy } from "../../support/backups.js";

/** Synthetic browser review data; no host, factory data, or external service is contacted. */
export const NOW = "2026-11-01T08:00:00Z";
export const user = officeUserSchema.parse({ ...userFixture, name: "Ирина Смирнова" });
export const product = officeProductSchema.parse(productFixture);
export const products = [
  product,
  officeProductSchema.parse({
    ...productFixture,
    id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0c",
    name: "Кефир 2,5% 0,9 л",
    printName: "Кефир 2,5%",
    gtin14: "04601234000017",
    boxCapacity: 6,
  }),
  officeProductSchema.parse({
    ...productFixture,
    id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0d",
    name: "Ряженка 4% 0,5 л",
    printName: "Ряженка 4%",
    gtin14: "04602222000026",
    status: "draft",
    boxCapacity: null,
    chzProductGroupCode: null,
  }),
];
export const shifts = [
  officeShiftSchema.parse({
    ...shiftFixture,
    number: "NOV01-001",
    plannedDate: "2026-11-01",
    productionDate: "2026-11-01",
    openedAt: "2026-11-01T06:02:00Z",
    createdAt: "2026-10-31T15:30:00Z",
    totals: { ...shiftFixture.totals, lastFactAt: "2026-11-01T07:58:07Z" },
  }),
  officeShiftSchema.parse({
    ...shiftFixture,
    id: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6c",
    number: "OCT31-002",
    status: "closed",
    plannedDate: "2026-10-31",
    productionDate: "2026-10-31",
    openedAt: "2026-10-31T06:00:00Z",
    closedAt: "2026-10-31T14:00:00Z",
    closeReasonCode: null,
    createdAt: "2026-10-30T15:00:00Z",
    totals: {
      ...shiftFixture.totals,
      acceptedUnits: 1200,
      unitsInClosedBoxes: 1200,
      closedBoxes: 100,
      openBoxes: 0,
      lastFactAt: "2026-10-31T13:58:00Z",
    },
  }),
  officeShiftSchema.parse({
    ...shiftFixture,
    id: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6d",
    number: "NOV02-001",
    status: "planned",
    plannedDate: "2026-11-02",
    productionDate: "2026-11-02",
    openedAt: null,
    ownerDeviceId: null,
    createdAt: "2026-11-01T07:00:00Z",
    totals: {
      acceptedUnits: 0,
      unitsInClosedBoxes: 0,
      closedBoxes: 0,
      openBoxes: 0,
      closedPallets: 0,
      openPallets: 0,
      lastFactAt: null,
      deviceIds: [],
    },
  }),
];
export const palletId = palletFixture.id;
export const pallet = {
  ...palletFixture,
  sscc: "146006820000000409",
  productId: product.id,
  productName: product.name,
  gtin14: product.gtin14,
  shelfLifeDays: product.shelfLifeDays,
  openedAt: "2026-11-01T07:40:00Z",
  closedAt: "2026-11-01T07:50:00Z",
  organization: { name: "ООО «Атолл»", inn: "7707083893", timeZone: "Europe/Moscow" },
  members: palletFixture.members.map((member) => ({
    ...member,
    shiftId: shiftFixture.id,
    shiftNumber: "NOV01-001",
    productionDate: "2026-11-01",
  })),
};

const responses: Record<string, unknown> = {
  "/v1/office/me": user,
  "/v1/office/org": { ...orgFixture, inn: "7707083893" },
  "/v1/office/org/logo": { logo: null },
  "/v1/device/login-branding": { logo: null },
  "/v1/office/license": { ...ACTIVE_LICENSE, effectiveAt: NOW },
  "/v1/office/lines": [
    { ...lineFixture, name: "Линия розлива № 1" },
    {
      ...lineFixture,
      id: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d62",
      name: "Линия упаковки № 2",
      maxStations: 1,
    },
  ],
  "/v1/office/products": products,
  "/v1/office/product-groups": [{ code: 8, alias: "milk", name: "Молочная продукция" }],
  "/v1/office/templates": [templateFixture],
  "/v1/office/counterparties": [counterpartyFixture],
  "/v1/office/shifts": shifts,
  "/v1/office/devices": [
    {
      ...deviceFixture,
      name: "Станция розлива № 1",
      appVersion: "1.2.0",
      protocol: 6,
      lastSeenAt: "2026-11-01T07:59:40Z",
      versionSeenAt: NOW,
    },
  ],
  "/v1/office/conflicts": { items: [], page: 1, pageCount: 1, total: 0 },
  "/v1/office/backups": {
    ...HEALTHY_BACKUPS,
    now: NOW,
    local: {
      ...HEALTHY_BACKUPS.local,
      lastAttempt: { at: "2026-11-01T06:00:03Z", trigger: "scheduled", ok: true, code: null },
      copies: [backupCopy("2026-11-01T06:00:00Z")],
    },
    second: {
      ...HEALTHY_BACKUPS.second,
      lastAttempt: { at: "2026-11-01T06:00:04Z", trigger: "scheduled", ok: true, code: null },
      copies: [backupCopy("2026-11-01T06:00:00Z")],
    },
  },
  "/v1/office/host-network": { ...networkFixture, confirmedAt: "2026-10-31T08:00:00Z" },
  "/v1/office/demo-data": {
    present: false,
    productId: null,
    shifts: 0,
    boxes: 0,
    pallets: 0,
    codes: 0,
    activeShifts: [],
  },
  "/v1/office/export-files/settings": exportSettingsFixture,
  "/v1/office/export-files": { items: [] },
  "/v1/office/warehouse-pallets": {
    pallets: [
      {
        id: pallet.id,
        deviceId: deviceFixture.id,
        deviceName: "Офис",
        productId: product.id,
        productName: product.name,
        openedAt: pallet.openedAt,
        closedAt: pallet.closedAt,
        sscc: pallet.sscc,
        boxes: pallet.boxes,
        boxCountReported: pallet.boxes,
      },
    ],
  },
  [`/v1/office/warehouse-pallets/${palletId}`]: pallet,
  "/v1/office/code-registry": {
    ...codeRegistryFixture,
    items: codeRegistryFixture.items
      .filter((item) => item.source === "local")
      .map((entry) => ({
        ...entry,
        item: {
          ...entry.item,
          shiftId: shiftFixture.id,
          shiftNumber: "NOV01-001",
          scannedAt: "2026-11-01T07:48:31Z",
          productionDate: "2026-11-01",
          lineName: "Линия розлива № 1",
          boxClosedAt: "2026-11-01T07:49:00Z",
        },
      })),
    total: 1,
  },
};

const client: HostClient = {
  async request(method, path, options) {
    const pathname = new URL(path, "https://office-review.invalid").pathname;
    if (method === "POST" && pathname === "/v1/office/search") {
      const query = officeSearchRequestSchema.parse(options.body);
      const warehouse = {
        id: `warehouse:${palletId}`,
        label: `Палет (00)${pallet.sscc}`,
        detail: "Молоко 3,2% · 12 шт.",
        target: { kind: "warehouse_pallet", id: palletId },
      };
      return options.schema.parse({
        items:
          query.kind === "sscc"
            ? [warehouse]
            : [
                warehouse,
                {
                  id: `product:${product.id}`,
                  label: product.name,
                  detail: `GTIN ${product.gtin14}`,
                  target: { kind: "product", id: product.id },
                },
                {
                  id: `shift:${shiftFixture.id}`,
                  label: "Смена NOV01-001",
                  detail: "Линия розлива № 1 · Активна",
                  target: { kind: "shift", id: shiftFixture.id, source: "local" },
                },
              ],
        truncated: false,
      });
    }
    if (method === "GET" && /^\/v1\/office\/users\/[^/]+\/avatar$/.test(pathname))
      return options.schema.parse({ avatar: null });
    if (method === "GET" && /^\/v1\/office\/products\/[^/]+\/photo$/.test(pathname))
      return options.schema.parse({ photo: null });
    if (method !== "GET" || !Object.hasOwn(responses, pathname))
      throw new Error(`Unconfigured Office review request: ${method} ${path}`);
    return options.schema.parse(responses[pathname]);
  },
};
export const api = createHostApi(client);
