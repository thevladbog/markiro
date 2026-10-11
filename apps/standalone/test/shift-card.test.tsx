import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeBox, OfficePallet, OfficeShift } from "../src/host/protocol.js";
import {
  endsWithTail,
  isLateBox,
  labelState,
  packState,
  palletCountDiffers,
  ssccTail,
} from "../src/office/shifts/shift-card.js";
import { ORG_PROFILE, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  CLOSED,
  expectFocusedNotice,
  openShifts,
  PALLET,
  PLANNED,
  shiftsSession,
} from "./support/shifts.js";

const STATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** The active shift with pallets of 40 boxes. */
const WITH_PALLETS: OfficeShift = {
  ...ACTIVE,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
};

function box(n: number, fields: Partial<OfficeBox> = {}): OfficeBox {
  return {
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    deviceId: STATION,
    sscc: `0460068200000${String(15000 + n).padStart(5, "0")}`,
    openedAt: "2026-10-08T06:05:12.031Z",
    closedAt: "2026-10-08T06:06:01.118Z",
    disassembledAt: null,
    palletId: null,
    units: 12,
    itemCountReported: 12,
    digestMatches: true,
    printVerifiedAt: null,
    printSkippedAt: null,
    ...fields,
  };
}

const PALLET_1: OfficePallet = {
  id: "a0000000-0000-4000-8000-000000000001",
  deviceId: STATION,
  sscc: "146006820000000409",
  openedAt: "2026-10-08T06:06:01.118Z",
  closedAt: "2026-10-08T06:20:44.650Z",
  disassembledAt: null,
  boxes: 1,
  units: 12,
  boxCountReported: 2,
  printVerifiedAt: "2026-10-08T06:20:51.300Z",
  printSkippedAt: null,
};
const PALLET_2: OfficePallet = {
  ...PALLET_1,
  id: "a0000000-0000-4000-8000-000000000002",
  sscc: null,
  closedAt: null,
  boxCountReported: null,
  printVerifiedAt: null,
};

/** Box 1 on pallet 1, box 2 taken apart from it, box 3 open on no pallet, box 4 whose digest failed. */
const BOXES: OfficeBox[] = [
  box(1, { palletId: PALLET_1.id, printVerifiedAt: "2026-10-08T06:06:09.540Z" }),
  box(2, {
    palletId: PALLET_1.id,
    units: 0,
    disassembledAt: "2026-10-08T07:00:00.000Z",
    printSkippedAt: "2026-10-08T06:07:20.001Z",
  }),
  box(3, { sscc: null, closedAt: null, units: 5, itemCountReported: null, digestMatches: null }),
  box(4, { digestMatches: false, palletId: PALLET_2.id }),
];

/** «Смены» with the shift listed, its card's reads stubbed. */
function cardSession(
  shift: OfficeShift,
  boxes: OfficeBox[] = BOXES,
  pallets: OfficePallet[] = [PALLET_1, PALLET_2],
): FakeOfficeSession {
  const session = shiftsSession([shift, PLANNED, CLOSED]);
  session.api.getShift.mockResolvedValue(shift);
  session.api.listShiftBoxes.mockResolvedValue(boxes);
  session.api.listShiftPallets.mockResolvedValue(pallets);
  return session;
}

/** Opens the shift's card from its number in the list. */
async function openCard(session: FakeOfficeSession, number: string): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${number}` }));
  await screen.findByRole("heading", { name: `Смена ${number}` });
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The card's definitions as term to description. */
function facts(): Record<string, string> {
  return Object.fromEntries(
    screen
      .getAllByRole("term")
      .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
  );
}

function lost(): HostError {
  return new HostError({ kind: "transport", code: "unreachable", message: "x" });
}

/** A closed box with an SSCC of its own; `n` even ends it with 0, odd with 1. */
function parity(n: number): OfficeBox {
  return box(n, { sscc: `0460068200000${String(n).padStart(4, "0")}${n % 2}` });
}

/** The rows of a section's table, cell texts each. */
function rowsOf(name: string): string[][] {
  return within(section(name))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

describe("the card of a shift (plan О-Ф)", () => {
  it("opens from the shift's number and shows the shift, its boxes and its pallets as the host has them now", async () => {
    const session = cardSession(WITH_PALLETS);
    await openCard(session, "OCT26-004");
    expect(session.api.getShift).toHaveBeenCalledWith("office-session-token", ACTIVE.id);
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    expect(screen.getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(screen.getByText("По 40 кор.")).toBeTruthy();
    expect(rowsOf("Короба")).toEqual([
      [
        "(00)046006820000015001",
        "12",
        "08.10.2026, 09:06",
        "(00)146006820000000409",
        "✓Закрыт",
        "Проверена",
        "Состав",
      ],
      [
        "(00)046006820000015002",
        "0",
        "08.10.2026, 09:06",
        "(00)146006820000000409",
        "⊘Расформирован08.10.2026, 10:00",
        "Пропущена",
        "Состав",
      ],
      ["Без SSCC", "5", "—", "—", "▸Открыт", "—", "Состав"],
      [
        "(00)046006820000015004",
        "12",
        "08.10.2026, 09:06",
        "Открытая",
        "✓Закрыт!Состав при закрытии не сошёлся",
        "Не проверялась",
        "Состав",
      ],
    ]);
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(3));
    expect(rowsOf("Паллеты")).toEqual([
      [
        "(00)146006820000000409",
        "1",
        "12",
        "08.10.2026, 09:20",
        "✓Закрыта!Счёт коробов станции другой",
        "СоставЯрлык",
      ],
      ["Без SSCC", "1", "12", "—", "▸Открыта", "Состав"],
    ]);
  });

  it("keeps the boxes whose SSCC ends with the digits typed, drops anything else typed, and says so when none does", async () => {
    const session = cardSession(ACTIVE);
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    // A shift without pallets does not ask for any.
    expect(session.api.listShiftPallets).not.toHaveBeenCalled();
    const tail = within(section("Короба")).getByLabelText("Последние цифры SSCC");
    fireEvent.change(tail, { target: { value: "5 00-2" } });
    expect(tail instanceof HTMLInputElement && tail.value).toBe("5002");
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015002"]);
    expect(screen.getByText("Показано 1 из 4")).toBeTruthy();
    fireEvent.change(tail, { target: { value: "999" } });
    expect(screen.getByText("Нет коробов с таким окончанием SSCC")).toBeTruthy();
    // A shift without pallets has no pallet column and no pallets.
    expect(screen.queryByRole("region", { name: "Паллеты" })).toBeNull();
    expect(within(section("Короба")).queryByRole("columnheader", { name: "Паллета" })).toBeNull();
  });

  it("shows the boxes fifty to a page", async () => {
    const many = Array.from({ length: 51 }, (_, index) => box(index + 1));
    await openCard(cardSession(ACTIVE, many), "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(51));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015051"]);
  });

  it("has neither boxes nor figures nor exports for a planned shift", async () => {
    const session = cardSession(PLANNED);
    session.api.listShifts.mockResolvedValue([PLANNED]);
    await openCard(session, PLANNED.number);
    expect(screen.queryByRole("region", { name: "Короба" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Итоги" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Выгрузка" })).toBeNull();
    expect(session.api.listShiftBoxes).not.toHaveBeenCalled();
  });

  it("closes an active shift from the card and reads it again, its boxes too", async () => {
    const session = cardSession(ACTIVE);
    const closed: OfficeShift = { ...ACTIVE, status: "closed", closeReasonText: "Сбой линии" };
    session.api.closeShift.mockResolvedValue(closed);
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(session.api.listShiftBoxes).toHaveBeenCalledTimes(1));
    session.api.getShift.mockResolvedValue(closed);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Сбой линии" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));
    await expectFocusedNotice("Смена OCT26-004 закрыта.");
    await waitFor(() => expect(session.api.listShiftBoxes).toHaveBeenCalledTimes(2));
    await screen.findByText("Закрыта в офисе: Сбой линии");
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
    expect(screen.getByRole("button", { name: "Выгрузка" })).toBeTruthy();
  });

  it("says when the shift did not load, and loads it again", async () => {
    const session = cardSession(ACTIVE);
    session.api.getShift.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openShifts(session);
    fireEvent.click(screen.getByRole("link", { name: "Карточка смены OCT26-004" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    fireEvent.click(screen.getByRole("link", { name: "← Смены" }));
    await screen.findByRole("heading", { name: "Смены" });
  });

  it("names the shift's product, line and counterparty, and its times in the organization's zone", async () => {
    const session = cardSession(WITH_PALLETS);
    // Kamchatka (UTC+12), so the organization's time is no PC's own by chance.
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(facts()["Открыта"]).toBe("08.10.2026, 18:02"));
    expect(facts()).toEqual({
      Товар: "Молоко 3,2% 0,9 л",
      "Дата производства": "08.10.2026",
      Линия: "Линия 2",
      Контрагент: "ООО «Северный берег»",
      Режим: "Агрегация",
      "План, шт": "1\u00a0200",
      "Вместимость короба, шт": "12",
      Паллеты: "По 40 кор.",
      Выпуск: "540 шт · 45 кор.",
      Открыта: "08.10.2026, 18:02",
      Закрыта: "—",
    });
  });

  it("says a shift without pallets and without a counterparty so", async () => {
    await openCard(cardSession({ ...ACTIVE, counterpartyId: null }), "OCT26-004");
    expect(facts()["Паллеты"]).toBe("Не собираются");
    expect(facts()["Контрагент"]).toBe("—");
  });

  it("has no pallets of a planned shift, whatever it plans", async () => {
    const session = cardSession({ ...PLANNED, palletsEnabled: true, palletBoxCapacity: 40 });
    session.api.listShifts.mockResolvedValue([PLANNED]);
    await openCard(session, PLANNED.number);
    expect(screen.queryByRole("region", { name: "Паллеты" })).toBeNull();
    expect(session.api.listShiftPallets).not.toHaveBeenCalled();
  });

  it("says a pallet taken apart by when, and not by the counts the host keeps for it", async () => {
    const apart: OfficePallet = {
      ...PALLET_1,
      boxes: 3,
      units: 36,
      boxCountReported: 2,
      disassembledAt: "2026-10-08T11:00:00.000Z",
    };
    await openCard(cardSession(WITH_PALLETS, BOXES, [apart]), "OCT26-004");
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(2));
    // «Счёт коробов станции другой» is not said of it: the count is stale by design.
    expect(rowsOf("Паллеты")).toEqual([
      [
        "(00)146006820000000409",
        "—",
        "—",
        "08.10.2026, 09:20",
        "⊘Расформирована08.10.2026, 14:00",
        "СоставЯрлык",
      ],
    ]);
  });

  it("says when the station counted a closed pallet's boxes otherwise, either way, and not when it agrees or counted none", async () => {
    const closed = (n: number, fields: Partial<OfficePallet>): OfficePallet => ({
      ...PALLET_1,
      id: `a0000000-0000-4000-8000-00000000010${n}`,
      sscc: `14600682000000040${n}`,
      boxes: 2,
      units: 24,
      boxCountReported: 2,
      ...fields,
    });
    const pallets = [
      closed(1, {}),
      closed(2, { boxCountReported: null }),
      closed(3, { boxCountReported: 1 }),
      closed(4, { boxCountReported: 3 }),
    ];
    await openCard(cardSession(WITH_PALLETS, [], pallets), "OCT26-004");
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(5));
    expect(rowsOf("Паллеты").map((row) => row[4])).toEqual([
      "✓Закрыта",
      "✓Закрыта",
      "✓Закрыта!Счёт коробов станции другой",
      "✓Закрыта!Счёт коробов станции другой",
    ]);
  });

  it("flags a box the station closed after its pallet, to the millisecond, and no other", async () => {
    const onPallet = (n: number, fields: Partial<OfficeBox>): OfficeBox =>
      box(n, { palletId: PALLET_1.id, ...fields });
    const boxes = [
      onPallet(5, { closedAt: "2026-10-08T06:25:00.000Z" }),
      // The very instant the pallet closed, and an earlier one written without milliseconds.
      onPallet(6, { closedAt: PALLET_1.closedAt }),
      onPallet(7, { closedAt: "2026-10-08T06:20:44.651Z" }),
      onPallet(8, { closedAt: "2026-10-08T06:20:44Z" }),
      // Late, but taken apart since: it no longer stands on the pallet.
      onPallet(9, {
        closedAt: "2026-10-08T06:25:00.000Z",
        disassembledAt: "2026-10-08T07:00:00.000Z",
      }),
      // On a pallet that is still open, and open itself.
      box(10, { palletId: PALLET_2.id, closedAt: "2026-10-08T06:25:00.000Z" }),
      onPallet(11, { closedAt: null }),
    ];
    await openCard(cardSession(WITH_PALLETS, boxes), "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(8));
    expect(rowsOf("Короба").map((row) => row[4])).toEqual([
      "✓Закрыт!Закрыт после закрытия паллеты",
      "✓Закрыт",
      "✓Закрыт!Закрыт после закрытия паллеты",
      "✓Закрыт",
      "⊘Расформирован08.10.2026, 10:00",
      "✓Закрыт",
      "▸Открыт",
    ]);
  });

  it("goes back to the first page when the digits typed change the boxes shown", async () => {
    const many = Array.from({ length: 140 }, (_, index) => parity(index + 1));
    await openCard(cardSession(ACTIVE, many), "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(51));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба")[0]?.[0]).toBe("(00)046006820000000511");
    // 70 boxes end with 0: two pages, and the typing starts the first again.
    fireEvent.change(within(section("Короба")).getByLabelText("Последние цифры SSCC"), {
      target: { value: "0" },
    });
    expect(screen.getByText("Показано 70 из 140")).toBeTruthy();
    expect(rowsOf("Короба")[0]?.[0]).toBe("(00)046006820000000020");
    expect(screen.getByText("Страница 1 из 2")).toBeTruthy();
  });

  it("opens the figures and the exports of a closed shift, and offers no close", async () => {
    const session = cardSession(CLOSED);
    session.api.listShifts.mockResolvedValue([CLOSED]);
    session.api.listDevices.mockResolvedValue([]);
    session.api.getShiftExportSource.mockReturnValue(new Promise(() => undefined));
    await openCard(session, CLOSED.number);
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Итоги" }));
    const totals = await screen.findByRole("dialog", { name: "Итоги смены OCT26-001/S" });
    fireEvent.click(within(totals).getAllByRole("button", { name: "Закрыть" }).at(-1) as Element);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Выгрузка" }));
    await screen.findByRole("dialog", { name: "Выгрузка смены OCT26-001/S" });
    expect(session.api.getShiftExportSource).toHaveBeenCalledWith(
      "office-session-token",
      CLOSED.id,
    );
  });

  it("says when the boxes or the pallets did not load, each in its own place, and loads them again", async () => {
    const session = cardSession(WITH_PALLETS);
    session.api.listShiftBoxes.mockRejectedValueOnce(lost());
    session.api.listShiftPallets.mockRejectedValue(lost());
    await openCard(session, "OCT26-004");
    const boxes = await waitFor(() => {
      const region = section("Короба");
      expect(within(region).getByRole("button", { name: "Повторить" })).toBeTruthy();
      return region;
    });
    await waitFor(() =>
      expect(within(section("Паллеты")).getByRole("button", { name: "Повторить" })).toBeTruthy(),
    );
    // The shift itself is on the page all the while.
    expect(screen.getByRole("heading", { name: "Смена OCT26-004" })).toBeTruthy();
    fireEvent.click(within(boxes).getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    // The pallets of the boxes are not "not found" when the list of pallets did not load.
    expect(rowsOf("Короба").map((row) => row[3])).toEqual([
      "Паллеты не загружены",
      "Паллеты не загружены",
      "—",
      "Паллеты не загружены",
    ]);
  });

  it("names the pallet of a box, says when it is not among the shift's pallets, and says it is not read yet", async () => {
    const stray = box(5, { palletId: "a0000000-0000-4000-8000-0000000000ff" });
    const session = cardSession(WITH_PALLETS, [BOXES[0] as OfficeBox, stray], [PALLET_1]);
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(3));
    expect(rowsOf("Короба").map((row) => row[3])).toEqual([
      "(00)146006820000000409",
      "Паллета не найдена",
    ]);
  });

  it("does not call a pallet missing while the pallets are still coming", async () => {
    const session = cardSession(WITH_PALLETS);
    session.api.listShiftPallets.mockReturnValue(new Promise(() => undefined));
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    expect(rowsOf("Короба").map((row) => row[3])).toEqual([
      "Загрузка…",
      "Загрузка…",
      "—",
      "Загрузка…",
    ]);
  });

  it("says a closed box's digest did not match, and says nothing of it once the box is taken apart", async () => {
    const boxes = [
      box(1, { digestMatches: false }),
      box(2, { digestMatches: false, disassembledAt: "2026-10-08T07:00:00.000Z" }),
      box(3, { digestMatches: true }),
    ];
    await openCard(cardSession(ACTIVE, boxes), "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(4));
    expect(rowsOf("Короба").map((row) => row[3])).toEqual([
      "✓Закрыт!Состав при закрытии не сошёлся",
      "⊘Расформирован08.10.2026, 10:00",
      "✓Закрыт",
    ]);
  });

  it("stays on the pages that are left when the boxes read again are fewer", async () => {
    const session = cardSession(
      ACTIVE,
      Array.from({ length: 51 }, (_, index) => box(index + 1)),
    );
    const closed: OfficeShift = { ...ACTIVE, status: "closed", closeReasonText: "Сбой линии" };
    session.api.closeShift.mockResolvedValue(closed);
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(51));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба")).toHaveLength(1);
    session.api.getShift.mockResolvedValue(closed);
    session.api.listShiftBoxes.mockResolvedValue(BOXES.slice(0, 3));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Сбой линии" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));
    await waitFor(() => expect(rowsOf("Короба")).toHaveLength(3));
  });

  it("offers to read the card again after a stale close, which closes the dialog and never resends", async () => {
    const session = cardSession(ACTIVE);
    session.api.closeShift.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale_revision",
        details: { currentRev: 80 },
      }),
    );
    await openCard(session, "OCT26-004");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Сбой линии" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));
    const reads = session.api.getShift.mock.calls.length;
    fireEvent.click(await within(dialog).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.getShift.mock.calls.length).toBeGreaterThan(reads));
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Смена OCT26-004 закрыта.")).toBeNull();
  });
});

describe("what the card says of a box or a pallet", () => {
  it("takes apart over closed, and closed over open", () => {
    expect(packState({ closedAt: null, disassembledAt: null })).toBe("open");
    expect(packState({ closedAt: "2026-10-08T06:00:00.000Z", disassembledAt: null })).toBe(
      "closed",
    );
    expect(
      packState({
        closedAt: "2026-10-08T06:00:00.000Z",
        disassembledAt: "2026-10-08T07:00:00.000Z",
      }),
    ).toBe("disassembled");
  });

  it("reads the later label check of the two", () => {
    const early = "2026-10-08T06:00:00.000Z";
    const late = "2026-10-08T06:00:00.001Z";
    expect(labelState({ printVerifiedAt: null, printSkippedAt: null })).toBe("none");
    expect(labelState({ printVerifiedAt: early, printSkippedAt: null })).toBe("verified");
    expect(labelState({ printVerifiedAt: null, printSkippedAt: early })).toBe("skipped");
    expect(labelState({ printVerifiedAt: late, printSkippedAt: early })).toBe("verified");
    expect(labelState({ printVerifiedAt: early, printSkippedAt: late })).toBe("skipped");
  });

  it("reads the label check by the instants, not by how the text sorts", () => {
    // Both are valid instants; as text «…:01Z» sorts after «…:01.500Z», as an instant before it.
    expect(
      labelState({
        printVerifiedAt: "2026-10-08T06:00:01.500Z",
        printSkippedAt: "2026-10-08T06:00:01Z",
      }),
    ).toBe("verified");
    expect(
      labelState({
        printVerifiedAt: "2026-10-08T06:00:01Z",
        printSkippedAt: "2026-10-08T06:00:01.500Z",
      }),
    ).toBe("skipped");
  });

  it("calls a box late only when it is closed, stands on a closed pallet and closed after it", () => {
    const pallet = { closedAt: "2026-10-08T06:20:44.650Z" };
    const closed = { closedAt: "2026-10-08T06:20:44.651Z", disassembledAt: null };
    expect(isLateBox(closed, pallet)).toBe(true);
    expect(isLateBox({ ...closed, closedAt: pallet.closedAt }, pallet)).toBe(false);
    expect(isLateBox({ ...closed, closedAt: "2026-10-08T06:20:44Z" }, pallet)).toBe(false);
    expect(isLateBox({ ...closed, closedAt: null }, pallet)).toBe(false);
    expect(isLateBox({ ...closed, disassembledAt: "2026-10-08T07:00:00.000Z" }, pallet)).toBe(
      false,
    );
    expect(isLateBox(closed, { closedAt: null })).toBe(false);
    expect(isLateBox(closed, undefined)).toBe(false);
  });

  it("calls a pallet's count different only for a closed pallet the station counted otherwise", () => {
    const pallet = {
      closedAt: "2026-10-08T06:20:44.650Z",
      disassembledAt: null,
      boxes: 2,
      boxCountReported: 3,
    };
    expect(palletCountDiffers(pallet)).toBe(true);
    expect(palletCountDiffers({ ...pallet, boxCountReported: 1 })).toBe(true);
    expect(palletCountDiffers({ ...pallet, boxCountReported: 2 })).toBe(false);
    expect(palletCountDiffers({ ...pallet, boxCountReported: null })).toBe(false);
    expect(palletCountDiffers({ ...pallet, closedAt: null })).toBe(false);
    expect(palletCountDiffers({ ...pallet, disassembledAt: "2026-10-08T07:00:00.000Z" })).toBe(
      false,
    );
  });

  it("filters by the digits an SSCC ends with", () => {
    expect(ssccTail(" 12-3a4")).toBe("1234");
    expect(endsWithTail("046006820000015002", "5002")).toBe(true);
    expect(endsWithTail("046006820000015002", "5003")).toBe(false);
    // The digits must end the SSCC, not stand anywhere in it.
    expect(endsWithTail("046006820000015002", "1500")).toBe(false);
    expect(endsWithTail("046006820000015002", "")).toBe(true);
    expect(endsWithTail(null, "")).toBe(true);
    expect(endsWithTail(null, "2")).toBe(false);
  });
});
