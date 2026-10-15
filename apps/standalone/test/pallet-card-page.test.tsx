import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { exportRows } from "./support/export-rows.js";
import { renderOffice, TECHNOLOGIST } from "./support/office.js";
import { fakeOfficeFiles } from "./support/office-files.js";
import { CARD_SHIFT, packSession, PALLET_CARD, PALLET_ROWS } from "./support/pack-cards.js";
import { freezeToday } from "./support/shifts.js";

const PATH = `/codes/pallet/${PALLET_CARD.id}`;
const TITLE = "Паллета (00)146006820000000409";

beforeEach(() => {
  freezeToday();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function section(name: string): HTMLElement {
  const found = screen.getByRole("heading", { name }).closest("section");
  if (found === null) throw new Error(`no section ${name}`);
  return found;
}

async function palletCard(value = packSession(), files = fakeOfficeFiles()) {
  value.api.getPalletReportRows.mockResolvedValue(PALLET_ROWS);
  value.api.getShiftExportSource.mockResolvedValue(exportRows());
  renderOffice(value, { initialPath: PATH, files });
  await screen.findByRole("heading", { name: TITLE });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Состав паллеты" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  return { value, files };
}

describe("the card of a pallet (plan КРТ)", () => {
  it("lists every box that joined it, and tells the one taken apart", async () => {
    await palletCard();
    const rows = within(section("Короба на паллете")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("(00)046006820000015017");
    expect(rows[0]?.textContent).toContain("Расформирован");
    expect(rows[0]?.textContent).toContain("Короб расформирован");
    expect(rows[1]?.textContent).toContain("(00)046006820000015000");
    expect(rows[1]?.textContent).toContain("Закрыт");
    expect(rows[1]?.textContent).not.toContain("Короб расформирован");
  });

  it("says in plain words, and neutrally, that a box taken apart is the whole difference from the station's count", async () => {
    await palletCard();
    // The fixture is the owner's repacking: two boxes at the close, one taken apart since.
    expect(screen.queryByText("Состав изменился после закрытия")).toBeNull();
    const tag = screen.getByText("Состав изменён расформированием").closest("[title]");
    const hint =
      "Станция насчитала при закрытии коробов: 2, в базе хоста сейчас: 1. После расформирования коробов числа расходятся (расформировано: 1). Это не ошибка.";
    expect(tag?.getAttribute("title")).toBe(hint);
    expect(tag?.getAttribute("aria-description")).toBe(hint);
    // A neutral tag, not the warning's: no «!» glyph.
    expect(tag?.textContent).not.toContain("!");
  });

  it.each([
    [
      "no box taken apart",
      0,
      "Станция насчитала при закрытии коробов: 2, в базе хоста сейчас: 1. Расформирований коробов этой паллеты нет, поэтому расхождение настоящее: проверьте состав паллеты.",
    ],
    [
      "a taken-apart box that does not account for it",
      3,
      "Станция насчитала при закрытии коробов: 2, в базе хоста сейчас: 1. Расформирование объясняет не всё расхождение (расформировано: 3): проверьте состав паллеты.",
    ],
  ])("keeps the warning, saying the difference is real, with %s", async (_what, taken, hint) => {
    const value = packSession();
    value.api.getPalletCard.mockResolvedValue({ ...PALLET_CARD, disassembledBoxes: taken });
    value.api.getPalletReportRows.mockResolvedValue(PALLET_ROWS);
    renderOffice(value, { initialPath: PATH });
    const tag = (await screen.findByText("Состав изменился после закрытия")).closest("[title]");
    expect(screen.queryByText("Состав изменён расформированием")).toBeNull();
    expect(tag?.getAttribute("title")).toBe(hint);
    expect(tag?.getAttribute("aria-description")).toBe(hint);
  });

  it("says in words that the station counted other boxes at the close than stand now", async () => {
    const value = packSession();
    value.api.getPalletCard.mockResolvedValue({ ...PALLET_CARD, disassembledBoxes: 0 });
    value.api.getPalletReportRows.mockResolvedValue(PALLET_ROWS);
    renderOffice(value, { initialPath: PATH });
    await screen.findByRole("heading", { name: /Паллета/ });
    expect(await screen.findAllByText("Состав изменился после закрытия")).toHaveLength(1);
    const facts = Object.fromEntries(
      screen
        .getAllByRole("term")
        .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
    );
    expect(facts["Коробов стоит"]).toBe("1");
    expect(facts["Станция насчитала при закрытии"]).toBe("2");
    expect(facts["Кодов"]).toBe("1");
    expect(facts["Смена"]).toBe("OCT26-003");
  });

  it("tells the station's exceptions in words", async () => {
    await palletCard();
    const item = within(section("Исключения")).getByRole("listitem");
    expect(item.textContent).toContain("Перепечатка ярлыка (причина — Этикетка повреждена)");
  });

  it("opens a box's card from its row", async () => {
    const { value } = await palletCard();
    const rows = within(section("Короба на паллете")).getAllByRole("row").slice(1);
    fireEvent.click(rows[1] as HTMLElement);
    await screen.findByRole("heading", { name: "Короб (00)046006820000015000" });
    expect(value.api.getBoxCard).toHaveBeenCalledWith(
      "office-session-token",
      "b0000000-0000-4000-8000-000000000001",
    );
  });

  it("prints «Состав паллеты» and the placard of this pallet", async () => {
    const { value } = await palletCard();
    fireEvent.click(screen.getByRole("button", { name: "Состав паллеты" }));
    await screen.findByRole("dialog", { name: `Состав паллеты (00)146006820000000409` });
    expect(value.api.getPalletReportRows).toHaveBeenCalledWith(
      "office-session-token",
      CARD_SHIFT.id,
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getAllByRole("button", {
        name: "Закрыть",
      })[0] as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Ярлык паллеты" }));
    await screen.findByRole("dialog", { name: `Ярлык паллеты (00)146006820000000409` });
  });

  it("has a placard and a pallet XML only for a pallet closed and with an SSCC", async () => {
    const value = packSession();
    value.api.getPalletCard.mockResolvedValue({
      ...PALLET_CARD,
      sscc: null,
      closedAt: null,
      boxCountReported: null,
    });
    value.api.getPalletReportRows.mockResolvedValue(PALLET_ROWS);
    renderOffice(value, { initialPath: PATH });
    await screen.findByRole("heading", { name: "Паллета без SSCC" });
    expect(screen.getByRole("button", { name: "Состав паллеты" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ярлык паллеты" })).toBeNull();
    expect(screen.queryByRole("button", { name: "XML паллеты" })).toBeNull();
    expect(screen.getByText("Открыта")).toBeTruthy();
  });

  it("saves this pallet's XML, in a dialog with the pallet only and no shift formats", async () => {
    const { value, files } = await palletCard();
    value.api.recordShiftExport.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "XML паллеты" }));
    const dialog = await screen.findByRole("dialog", { name: "XML паллеты 146006820000000409" });
    await within(dialog).findByRole("button", { name: "XML паллеты 146006820000000409" });
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Сформировать и сохранить" })).toBeNull();
    expect(within(dialog).getAllByText(/Паллета 146006820000000409, коробов/)).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "XML паллеты 146006820000000409" }));
    await within(dialog).findByText(/^Сохранено файлов: 1\./);
    expect(files.save).toHaveBeenCalledTimes(1);
    expect(files.save.mock.calls[0]?.[0].at(-1)).toMatch(/pallet_xml_gismt_aggregation$/);
    expect(value.api.recordShiftExport.mock.calls[0]?.[2]).toMatchObject({
      formatId: "pallet_xml_gismt_aggregation",
      palletId: "a0000000-0000-4000-8000-000000000001",
    });
  });

  it("lists the applied documents that took the pallet apart", async () => {
    const value = packSession();
    value.api.getPalletCard.mockResolvedValue({
      ...PALLET_CARD,
      documents: [
        {
          id: "d0c00000-0000-4000-8000-000000000002",
          docNo: "DSG-26-0002",
          appliedAt: "2026-10-26T09:00:00Z",
          reasonName: null,
          appliedByName: null,
        },
      ],
    });
    value.api.getPalletReportRows.mockResolvedValue(PALLET_ROWS);
    await palletCard(value);
    const item = within(section("Документы дезагрегации")).getByRole("listitem");
    expect(item.textContent).toContain("DSG-26-0002");
    expect(
      within(item).getByRole("link", { name: "Открыть документ DSG-26-0002" }).getAttribute("href"),
    ).toBe("/disaggregation/d0c00000-0000-4000-8000-000000000002");
  });

  it("says a pallet the host never saw is not found", async () => {
    const value = packSession();
    value.api.getPalletCard.mockRejectedValue(
      new HostError({ kind: "api", code: "not_found", message: "no such pallet", status: 404 }),
    );
    renderOffice(value, { initialPath: PATH });
    await screen.findByText("Паллета не найдена");
  });

  it("is open to a technologist", async () => {
    await palletCard(packSession(undefined, TECHNOLOGIST));
  });
});
