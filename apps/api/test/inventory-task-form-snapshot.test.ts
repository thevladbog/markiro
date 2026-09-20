import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  renderInventoryTaskFormHtml,
  type InventoryTaskFormData,
} from "../src/modules/inventories/inventory-task-form";

/**
 * The printed inventory task form is a published artefact: MKR-INS-06's
 * `task-form.png` is screenshotted from this exact HTML. Extracting shared
 * print chrome for the shift form must not move a single byte of it, so this
 * fixture is a characterisation lock rather than a readability aid.
 */
const SNAPSHOT = readFileSync(
  join(__dirname, "fixtures", "inventory-task-form.snapshot.html"),
  "utf8",
);

const FIXTURE: InventoryTaskFormData = {
  inventoryId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "IVN-26-0042",
  status: "ready",
  organizationName: "ООО «Пивоварня»",
  productName: "Пиво светлое 0,45 л",
  gtin14: "04680089900383",
  lineName: "Упаковка А",
  mode: "repack",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  expectedCount: 4_116,
  boxCapacity: 20,
  generatedAt: new Date("2026-08-24T14:40:00.000Z"),
};

describe("inventory task form byte lock", () => {
  it("renders exactly the bytes MKR-INS-06 was screenshotted from", () => {
    expect(renderInventoryTaskFormHtml(FIXTURE)).toBe(SNAPSHOT);
  });
});
