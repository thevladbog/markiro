import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { officePalletSchema } from "../src/host/protocol.js";
import { TECHNOLOGIST } from "./support/office.js";
import {
  BOX_CARD,
  CARD_SHIFT,
  openCodes,
  packSession,
  PALLET_CARD,
  SHIFT_BOXES,
} from "./support/pack-cards.js";
import { chooseText, optionTexts } from "./support/select.js";
import { ACTIVE, PLANNED } from "./support/shifts.js";

const OPTION = "OCT26-003 · 08.10.2026 · Молоко 3,2% 0,9 л";
const CHECK_SHIFT = {
  ...ACTIVE,
  id: "3e1b7a5d-9f4a-4c6b-8d0e-5a8f1b4c7d9e",
  number: "OCT26-009",
  mode: "validation" as const,
};
const PALLETS = [
  officePalletSchema.parse({
    id: "a0000000-0000-4000-8000-000000000001",
    deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    sscc: "146006820000000409",
    openedAt: "2026-10-08T06:06:01.118Z",
    closedAt: "2026-10-08T06:20:44.650Z",
    disassembledAt: null,
    boxes: 1,
    units: 2,
    boxCountReported: 1,
    printVerifiedAt: null,
    printSkippedAt: null,
  }),
];

function session(user?: Parameters<typeof packSession>[1]) {
  const value = packSession([CARD_SHIFT, PLANNED, CHECK_SHIFT, ACTIVE], user);
  value.api.listShiftPallets.mockResolvedValue(PALLETS);
  return value;
}

async function boxesOf(value = session()) {
  await openCodes(value, `/codes/boxes?shift=${CARD_SHIFT.id}`);
  await screen.findByRole("table");
  return value;
}

describe("«Короба» (plan КРТ)", () => {
  it("asks for a shift first and reads no boxes until one is chosen", async () => {
    const value = session();
    await openCodes(value, "/codes/boxes");
    expect(screen.getByText("Выберите смену, чтобы увидеть её короба")).toBeTruthy();
    expect(value.api.listShiftBoxes).not.toHaveBeenCalled();
  });

  it("offers neither a planned shift nor a shift of a check of codes", async () => {
    await openCodes(session(), "/codes/boxes");
    const texts = optionTexts("Смена");
    expect(texts).toContain(OPTION);
    expect(texts.some((text) => text.startsWith("OCT26-005"))).toBe(false);
    expect(texts.some((text) => text.startsWith("OCT26-009"))).toBe(false);
    expect(texts.some((text) => text.startsWith("OCT26-004"))).toBe(true);
  });

  it("lists the boxes of the chosen shift with the line, the state and the operator", async () => {
    const value = session();
    await openCodes(value, "/codes/boxes");
    chooseText("Смена", OPTION);
    await screen.findByRole("table");
    expect(value.api.listShiftBoxes).toHaveBeenCalledWith("office-session-token", CARD_SHIFT.id);
    expect(screen.getByText("Линия: Линия 2 · Закрыта")).toBeTruthy();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(SHIFT_BOXES.length);
    expect(rows[0]?.textContent).toContain("Анна Кузнецова");
    expect(rows[0]?.textContent).toContain("(00)046006820000015000");
    expect(rows[0]?.textContent).toContain("Закрыт");
    expect(rows[2]?.textContent).toContain("Открыт");
    expect(screen.getByRole("columnheader", { name: "Оператор" })).toBeTruthy();
  });

  it("reads a shift an old link names that the host's own list lacks, and offers it", async () => {
    const value = packSession([ACTIVE]);
    value.api.listShifts.mockResolvedValue([ACTIVE]);
    await openCodes(value, `/codes/boxes?shift=${CARD_SHIFT.id}`);
    await screen.findByRole("table");
    expect(value.api.getShift).toHaveBeenCalledWith("office-session-token", CARD_SHIFT.id);
    expect(optionTexts("Смена")).toContain(OPTION);
  });

  it("opens a box's card from its row, by the mouse and by the keyboard", async () => {
    const value = await boxesOf();
    const first = within(screen.getByRole("table")).getAllByRole("row")[1] as HTMLElement;
    fireEvent.click(first);
    await screen.findByRole("heading", { name: "Короб (00)046006820000015000" });
    expect(value.api.getBoxCard).toHaveBeenCalledWith("office-session-token", SHIFT_BOXES[0]?.id);
  });

  it("opens the card from the keyboard, too", async () => {
    const value = await boxesOf();
    const first = within(screen.getByRole("table")).getAllByRole("row")[1] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "Enter" });
    await screen.findByRole("heading", { name: "Короб (00)046006820000015000" });
    expect(value.api.getBoxCard).toHaveBeenCalledTimes(1);
  });

  it("opens the pallet's card, not the box's, from the pallet link of a row", async () => {
    const value = await boxesOf();
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(await screen.findByRole("link", { name: "(00)146006820000000409" }));
    await screen.findByRole("heading", { name: `Паллета (00)${PALLET_CARD.sscc ?? ""}` });
    expect(value.api.getPalletCard).toHaveBeenCalledWith(
      "office-session-token",
      "a0000000-0000-4000-8000-000000000001",
    );
    expect(value.api.getBoxCard).not.toHaveBeenCalled();
  });

  it("filters the boxes by the last digits of the SSCC", async () => {
    await boxesOf();
    fireEvent.change(screen.getByLabelText("Последние цифры SSCC"), { target: { value: "5017" } });
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("046006820000015017");
  });

  it("is open to a technologist", async () => {
    await boxesOf(session(TECHNOLOGIST));
    expect(BOX_CARD.id).toBe(SHIFT_BOXES[0]?.id);
  });
});
