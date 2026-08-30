import { describe, expect, it } from "vitest";

import {
  buildInventoryActViewModel,
  generateInventoryActPdf,
} from "../src/modules/inventories/inventory-act-pdf";
import type {
  InventoryResultCode,
  InventoryResultSource,
} from "../src/modules/inventories/inventory-result-source.service";

const metadata = {
  documentId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "INVENTORY-26-0007",
  fileDateTime: "2026-08-30T15:18:00.000Z",
  operationDateTime: "2026-08-30T15:15:00.000Z",
  organizationName: "ООО «Кармилла»",
  organizationInn: "7700000000",
};

const code = (
  index: number,
  overrides: Partial<InventoryResultCode> = {},
): InventoryResultCode => ({
  codeHash: String(index).padStart(64, "0"),
  canonicalRaw: `010468008990006021SERIAL-${index}`,
  gtin14: "04680089900060",
  serial: `SERIAL-${index}`,
  sourceStatus: "INTRODUCED",
  sourceState: null,
  sourceProductionDate: "2026-08-29",
  parentSscc: null,
  observedProductionDate: "2026-08-29",
  classification: "expected",
  found: true,
  winner: { terminalId: "terminal-1", scannedAt: "2026-08-30T10:00:00.000Z" },
  ...overrides,
});

const source: InventoryResultSource = {
  inventoryId: "22222222-2222-4222-8222-222222222222",
  snapshotId: "33333333-3333-4333-8333-333333333333",
  resultRevision: 10,
  sourceSnapshotStartedAt: "2026-08-30T15:17:00.000Z",
  operation: {
    gtin14: "04680089900060",
    productName: "Сидр фруктовый газированный «Кармилла Сайдер» 0,33 л",
    lineName: "Склад",
    mode: "check",
    productionDateFrom: "2025-09-01",
    productionDateTo: "2026-08-30",
    startedAt: "2026-08-29T06:40:00.000Z",
    closedAt: "2026-08-30T15:15:00.000Z",
    emergencyCloseReason: null,
    snapshotRevision: 1,
    snapshotFixedAt: "2026-08-29T06:32:00.000Z",
    statusCounts: {
      EMITTED: 2,
      INTRODUCED: 102,
      APPLIED: 1,
      RETIRED: 4,
      WRITTEN_OFF: 0,
      DISAGGREGATION: 0,
    },
  },
  expected: Array.from({ length: 82 }, (_, index) => code(index + 1)),
  verified: Array.from({ length: 80 }, (_, index) => code(index + 1)),
  writeOffCandidates: [
    code(81, { found: false, winner: null }),
    code(82, { found: false, winner: null }),
  ],
  protected: Array.from({ length: 3 }, (_, index) =>
    code(101 + index, {
      sourceState: "MOVING_BY_UD",
      classification: "protected",
      found: index < 2,
      winner:
        index < 2 ? { terminalId: "terminal-1", scannedAt: "2026-08-30T10:00:00.000Z" } : null,
    }),
  ),
  ineligible: [
    code(201, { sourceStatus: "RETIRED", classification: "ineligible" }),
    code(202, { sourceStatus: "RETIRED", classification: "ineligible" }),
  ],
  unknown: [code(301, { sourceStatus: null, classification: "unknown" })],
  oldBoxes: [],
  newBoxes: [],
  observedDateGroups: [],
};

describe("inventory act PDF", () => {
  it("builds auditable result, status, and signature data from one frozen revision", async () => {
    const view = buildInventoryActViewModel(source, metadata);
    expect(view).toMatchObject({
      inventoryNumber: "INVENTORY-26-0007",
      organizationName: "ООО «Кармилла»",
      organizationInn: "7700000000",
      mode: "Без переупаковки",
      closeType: "Штатное",
      expectedCount: 82,
      verifiedCount: 80,
      missingCount: 2,
      verifiedPercent: "97,6 %",
      protectedCount: 3,
      ineligibleCount: 2,
      unknownCount: 1,
      barcodeValue: "INVENTORY-26-0007",
      signatures: [
        "Председатель комиссии",
        "Член комиссии",
        "Член комиссии",
        "Материально ответственное лицо",
      ],
    });
    expect(view.statusRows).toEqual([
      { label: "В обороте", code: "INTRODUCED", total: 82, checked: 80, result: "−2" },
      { label: "В отгрузке", code: "MOVING_BY_UD", total: 3, checked: 2, result: "исключено" },
      { label: "Эмитирован", code: "EMITTED", total: 2, checked: 0, result: "не учитывается" },
      { label: "Нанесён", code: "APPLIED", total: 1, checked: 0, result: "не учитывается" },
      { label: "Выбыл", code: "RETIRED", total: 4, checked: 2, result: "не учитывается" },
    ]);
  });

  it("renders deterministic one-page PDF bytes", async () => {
    const first = await generateInventoryActPdf(source, metadata);
    const retry = await generateInventoryActPdf(source, metadata);
    const firstPart = first[0];
    const retryPart = retry[0];
    expect(firstPart).toMatchObject({
      filename: "inventory-INVENTORY-26-0007-act.pdf",
      mimeType: "application/pdf",
      rowCount: 1,
      codeCount: 82,
      boxCount: 0,
    });
    expect(
      Buffer.from(firstPart?.bytes ?? [])
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(countPdfPages(Buffer.from(firstPart?.bytes ?? []))).toBe(1);
    expect(Buffer.from(firstPart?.bytes ?? []).equals(Buffer.from(retryPart?.bytes ?? []))).toBe(
      true,
    );
  });
});

const countPdfPages = (pdf: Buffer) =>
  (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
