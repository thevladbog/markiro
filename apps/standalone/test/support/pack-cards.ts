import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor } from "@testing-library/react";

import {
  officeBoxCardSchema,
  officePalletCardSchema,
  officePalletPageSchema,
  type OfficeBoxCard,
  type OfficePalletCard,
  type OfficePalletPage,
} from "../../src/host/pack-cards.js";
import type { OfficeCodeCard } from "../../src/host/code-search.js";
import {
  boxReportRowsSchema,
  officeBoxSchema,
  palletReportRowsSchema,
  type OfficeBox,
  type OfficeShift,
} from "../../src/host/protocol.js";
import { renderOffice, type FakeOfficeSession } from "./office.js";
import { CLOSED, PALLET, shiftsSession } from "./shifts.js";

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const supportModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../proto/fixtures/${name}`, supportModuleUrl), "utf8"),
  );
}

export const BOX_CARD: OfficeBoxCard = officeBoxCardSchema.parse(fixture("office-box-card.json"));
export const PALLET_CARD: OfficePalletCard = officePalletCardSchema.parse(
  fixture("office-pallet-card.json"),
);
export const PALLET_PAGE: OfficePalletPage = officePalletPageSchema.parse(
  fixture("office-pallet-page.json"),
);
export const SHIFT_BOXES: OfficeBox[] = officeBoxSchema.array().parse(fixture("office-boxes.json"));

/** The shift both cards name: closed, with pallets. */
export const CARD_SHIFT: OfficeShift = {
  ...CLOSED,
  id: BOX_CARD.shift.id,
  number: BOX_CARD.shift.number,
  createdFrom: "office",
  productionDate: BOX_CARD.shift.productionDate,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
};

/** The office's session with the cards, the pallet list and the shift they name stubbed. */
export function packSession(
  shifts: OfficeShift[] = [CARD_SHIFT],
  user?: Parameters<typeof shiftsSession>[1],
): FakeOfficeSession {
  const session = shiftsSession(shifts, user);
  session.api.getShift.mockImplementation(async (_token, id) => {
    const found = [...shifts, CARD_SHIFT].find((shift) => shift.id === id);
    if (found === undefined) throw new Error(`no shift ${id}`);
    return found;
  });
  session.api.getBoxCard.mockResolvedValue(BOX_CARD);
  session.api.getPalletCard.mockResolvedValue(PALLET_CARD);
  session.api.listPallets.mockResolvedValue(PALLET_PAGE);
  session.api.listShiftBoxes.mockResolvedValue(SHIFT_BOXES);
  session.api.listShiftPallets.mockResolvedValue([]);
  return session;
}

/** Opens «Поиск кодов» from the menu and waits for its heading. */
export async function openCodes(session: FakeOfficeSession, path = "/codes"): Promise<void> {
  renderOffice(session, { initialPath: path });
  await screen.findByRole("tablist", { name: "Разделы поиска кодов" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

/** Chooses a part of «Поиск кодов» by its tab. */
export function chooseTab(name: "Коды" | "Короба" | "Паллеты"): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

/** What «Состав короба» prints (`box-report-rows.json`) and the pallets' forms. */
export const BOX_ROWS = boxReportRowsSchema.parse(fixture("box-report-rows.json"));
export const PALLET_ROWS = palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));

/** The `OfficeCodeCard` fixture of the code search, for a card's link to a code. */
export const CODE_CARD = fixture("office-code-card.json") as OfficeCodeCard;
