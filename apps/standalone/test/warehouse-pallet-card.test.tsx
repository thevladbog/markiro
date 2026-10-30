import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OfficeWarehousePalletDetail } from "../src/host/office-pallet-create.js";
import { renderOffice } from "./support/office.js";
import { fakeOfficeFiles } from "./support/office-files.js";
import { packSession } from "./support/pack-cards.js";

export const WAREHOUSE_CARD: OfficeWarehousePalletDetail = {
  demo: false,
  id: "a1000000-0000-4000-8000-000000000001",
  sscc: "146006820000000409",
  source: "cabinet",
  createdByName: "Анна",
  deviceName: "Офис",
  productId: "b1000000-0000-4000-8000-000000000001",
  productName: "Молоко",
  gtin14: "04600682000013",
  shelfLifeDays: 5,
  openedAt: "2026-10-30T06:00:00Z",
  closedAt: "2026-10-30T06:00:00Z",
  disassembledAt: null,
  boxes: 2,
  units: 24,
  organization: { name: "Завод", inn: "7707083893", timeZone: "Europe/Moscow" },
  members: [
    {
      membershipId: "m1",
      id: "b1",
      sscc: "046006820000015000",
      shiftId: "s1",
      shiftNumber: "OCT30-001",
      productionDate: "2026-10-29",
      units: 12,
      disassembledAt: null,
      removedAt: null,
    },
    {
      membershipId: "m2",
      id: "b2",
      sscc: "046006820000015017",
      shiftId: "s2",
      shiftNumber: "OCT30-002",
      productionDate: "2026-10-30",
      units: 12,
      disassembledAt: null,
      removedAt: null,
    },
  ],
};
async function open(card = WAREHOUSE_CARD) {
  const session = packSession();
  session.api.getWarehousePallet.mockResolvedValue(card);
  const files = fakeOfficeFiles();
  const print = vi.fn(async (_html: string) => undefined);
  renderOffice(session, {
    initialPath: `/codes/warehouse-pallet/${card.id}`,
    files,
    printForm: print,
  });
  await screen.findByRole("heading", { name: "Палет (00)146006820000000409" });
  return { session, files, print };
}
describe("warehouse pallet card", () => {
  it("shows office creator and each box's real shift and date without loading a synthetic shift", async () => {
    const { session } = await open();
    expect(screen.getByText("Анна")).toBeTruthy();
    expect(screen.getByRole("link", { name: /OCT30-001/ }).getAttribute("href")).toContain("s1");
    expect(screen.getByRole("link", { name: /OCT30-002/ }).getAttribute("href")).toContain("s2");
    expect(session.api.getShift).not.toHaveBeenCalled();
  });
  it("prints the placard using both production dates and stores its exact HTML", async () => {
    const { session, print } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Ярлык палета" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.classList.contains("mk-side-panel")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const html = print.mock.calls[0]?.[0] ?? "";
    expect(html).toContain("29.10.2026");
    expect(html).toContain("30.10.2026");
    expect(session.api.beginExportFile.mock.calls[0]?.[1]).toMatchObject({
      targetType: "warehouse_pallet",
      targetId: WAREHOUSE_CARD.id,
      formatId: "form_placard",
    });
  });
  it("refuses new XML when the pallet was disassembled before the press", async () => {
    const { session, files } = await open();
    fireEvent.click(screen.getByRole("button", { name: "XML палета" }));
    session.api.getWarehousePallet.mockResolvedValue({
      ...WAREHOUSE_CARD,
      disassembledAt: "2026-10-30T07:00:00Z",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать XML" }));
    await screen.findByText("Палет расформирован. Новый XML недоступен.");
    expect(files.save).not.toHaveBeenCalled();
  });
  it("saves XML containing the pallet and box codes without repeating unit aggregations", async () => {
    const { session, files } = await open();
    fireEvent.click(screen.getByRole("button", { name: "XML палета" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать XML" }));
    await waitFor(() => expect(files.save).toHaveBeenCalledTimes(1));
    const bytes = files.save.mock.calls[0]?.[1][0]?.bytes;
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain("00146006820000000409");
    expect(xml).toContain("00046006820000015000");
    expect(xml.match(/<pack_content>/gu)).toHaveLength(1);
    expect(xml.match(/<cis>/gu)).toHaveLength(2);
    expect(session.api.beginExportFile.mock.calls[0]?.[1]).toMatchObject({
      targetType: "warehouse_pallet",
      kind: "pallet_export",
    });
  });
});
