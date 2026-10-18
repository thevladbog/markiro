import { screen, waitFor, within } from "@testing-library/react";
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

describe("warehouse pallets in «Поиск кодов» → «Паллеты» (plan ТСД-Х, decision В-6)", () => {
  it("lists what handhelds built outside shifts, open ones first, and nothing more", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue(WAREHOUSE);
    await openCodes(session, "/codes/pallets");
    const section = await screen.findByRole("region", { name: "Складские паллеты" });
    const table = await within(section).findByRole("table");
    const rows = within(table).getAllByRole("row");
    // The header and two pallets: the open one (no SSCC yet) first.
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Открыта")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("3")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("(00)146006820000000409")).toBeTruthy();
    expect(within(section).queryByRole("link")).toBeNull();
    await waitFor(() => expect(session.api.listWarehousePallets).toHaveBeenCalledTimes(1));
  });

  it("says there are none when no handheld built a pallet", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue({ pallets: [] });
    await openCodes(session, "/codes/pallets");
    const section = await screen.findByRole("region", { name: "Складские паллеты" });
    expect(await within(section).findByText("Складских паллет пока нет.")).toBeTruthy();
  });
});
