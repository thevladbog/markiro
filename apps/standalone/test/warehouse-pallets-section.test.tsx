import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { openCodes, packSession } from "./support/pack-cards.js";

const WAREHOUSE = {
  pallets: [
    {
      id: "a1000000-0000-4000-8000-000000000002",
      deviceId: "d1000000-0000-4000-8000-000000000001",
      deviceName: "ТСД 1",
      productId: "b1000000-0000-4000-8000-000000000001",
      productName: "Молоко 3,2% 0,9 л",
      openedAt: "2026-10-08T06:02:00.000Z",
      closedAt: null,
      sscc: null,
      boxes: 3,
      boxCountReported: null,
    },
    {
      id: "a1000000-0000-4000-8000-000000000001",
      deviceId: "d1000000-0000-4000-8000-000000000001",
      deviceName: "ТСД 1",
      productId: "b1000000-0000-4000-8000-000000000001",
      productName: "Молоко 3,2% 0,9 л",
      openedAt: "2026-10-08T05:00:00.000Z",
      closedAt: "2026-10-08T05:30:00.000Z",
      sscc: "146006820000000409",
      boxes: 40,
      boxCountReported: 40,
    },
  ],
};

describe("warehouse pallets in «Поиск кодов» → «Палеты» (plan ТСД-Х, decision В-6)", () => {
  it("lists what handhelds built outside shifts, open ones first, and nothing more", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue(WAREHOUSE);
    await openCodes(session, "/codes/pallets");
    const section = await screen.findByRole("region", { name: "Складские палеты" });
    const table = await within(section).findByRole("table");
    const rows = within(table).getAllByRole("row");
    // The header and two pallets: the open one (no SSCC yet) first.
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Открыт")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("3")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("(00)146006820000000409")).toBeTruthy();
    expect(within(section).getAllByRole("link")).toHaveLength(2);
    await waitFor(() => expect(session.api.listWarehousePallets).toHaveBeenCalledTimes(1));
  });

  it("says there are none when no handheld built a pallet", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue({ pallets: [] });
    await openCodes(session, "/codes/pallets");
    const section = await screen.findByRole("region", { name: "Складские палеты" });
    expect(await within(section).findByText("Складских палетов пока нет.")).toBeTruthy();
  });

  it("approves a rejected close only after review of the exact current box set", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue({ pallets: [] });
    const issue = {
      id: "a1000000-0000-4000-8000-000000000003",
      palletId: "a1000000-0000-4000-8000-000000000004",
      sscc: "146006820000000409",
      code: "pallet_count_mismatch",
      status: "pending" as const,
      reportedBoxes: 2,
      currentBoxes: 1,
      currentBoxSsccs: ["046006820000015024"],
      createdAt: "2026-11-11T08:00:00Z",
      deviceName: "Пост палетирования",
    };
    session.api.listPalletCloseIssues.mockResolvedValue([issue]);
    session.api.resolvePalletCloseIssue.mockResolvedValue({ ...issue, status: "approved" });
    await openCodes(session, "/codes/pallets");
    fireEvent.click(await screen.findByRole("button", { name: "Сверить состав" }));
    const dialog = await screen.findByRole("dialog", { name: "Сверка состава палеты" });
    expect(within(dialog).getByText("046006820000015024")).toBeTruthy();
    const approve = within(dialog).getByRole("button", { name: "Разрешить закрытие" });
    expect(approve).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(approve);
    await waitFor(() =>
      expect(session.api.resolvePalletCloseIssue).toHaveBeenCalledWith(
        expect.any(String),
        issue.id,
        { action: "approve_reclose", expectedBoxSsccs: issue.currentBoxSsccs },
      ),
    );
  });
});
