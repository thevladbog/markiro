import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { officeWarehousePalletDetailSchema } from "../src/host/office-pallet-create.js";
import {
  warehousePalletForm,
  warehousePalletXml,
} from "../src/office/codes/warehouse-pallet-documents.js";
const moduleUrl = import.meta.url;
const card = officeWarehousePalletDetailSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../proto/fixtures/office-warehouse-pallet-detail.json", moduleUrl),
      "utf8",
    ),
  ),
);
describe("warehouse pallet documents", () => {
  it("blocks new demo XML and marks a demo form's name and visible print output", () => {
    expect(() =>
      warehousePalletXml({ ...card, demo: true }, crypto.randomUUID(), new Date().toISOString()),
    ).toThrow("DEMO_SHIFT");
    const form = warehousePalletForm({ ...card, demo: true }, "placard", "a4", null);
    expect(form.fileName).toMatch(/^DEMO_/u);
    expect(form.html).toContain("ДЕМО");
  });
  it("does not re-aggregate members removed or disassembled after joining", () => {
    const first = card.members[0];
    if (!first) throw new Error("missing fixture member");
    const result = warehousePalletXml(
      {
        ...card,
        members: [
          first,
          { ...first, id: "old", sscc: "046006820000015017", removedAt: "2026-10-30T11:00:00Z" },
          {
            ...first,
            id: "broken",
            sscc: "046006820000015000",
            disassembledAt: "2026-10-30T11:00:00Z",
          },
        ],
      },
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    const xml = new TextDecoder().decode(result.bytes);
    expect(xml.match(/<cis>/gu)).toHaveLength(1);
  });
});
