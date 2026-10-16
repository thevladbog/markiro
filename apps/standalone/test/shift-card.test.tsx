import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeBox, OfficePallet, OfficeShift } from "../src/host/protocol.js";
import { officeShiftExportsSchema } from "../src/host/review.js";
import {
  endsWithTail,
  isLateBox,
  labelState,
  packState,
  palletCountDiffers,
  palletCountState,
  ssccTail,
} from "../src/office/shifts/shift-card.js";
import { ORG_PROFILE, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { BOX_CARD, PALLET_CARD } from "./support/pack-cards.js";
import {
  ACTIVE,
  CLOSED,
  expectFocusedNotice,
  openShifts,
  PALLET,
  PLANNED,
  shiftsSession,
} from "./support/shifts.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

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
  disassembledBoxes: 0,
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

/** Opens the shift's drawer from its number in the list, on a section when one is named. */
async function openCard(session: FakeOfficeSession, number: string, tab?: string): Promise<void> {
  await openCardView(session, number, tab);
}

/** `openCard`, with the rendered office to unmount. */
async function openCardView(session: FakeOfficeSession, number: string, tab?: string) {
  const view = await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${number}` }));
  await screen.findByRole("heading", { name: `Смена ${number}` });
  if (tab !== undefined) openTab(tab);
  return view;
}

/** Opens a section of the drawer by its tab: each reads when it is first opened. */
function openTab(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The card's definitions as term to description: the shift's own, not its figures' or print control's. */
function facts(): Record<string, string> {
  return Object.fromEntries(
    screen
      .getAllByRole("term")
      .filter((term) => term.closest(".shift-card__section") === null)
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
    const drawer = screen.getByRole("dialog", { name: "Смена OCT26-004" });
    expect(within(drawer).getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(within(drawer).getByText("По 40 кор.")).toBeTruthy();
    // The sections read when they are opened, not before.
    expect(session.api.listShiftBoxes).not.toHaveBeenCalled();
    openTab("Короба");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
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
    openTab("Паллеты");
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
    await openCard(session, "OCT26-004", "Короба");
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
    expect(screen.queryByRole("tab", { name: "Паллеты" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Паллеты" })).toBeNull();
    expect(within(section("Короба")).queryByRole("columnheader", { name: "Паллета" })).toBeNull();
  });

  it("opens with the box a conflict's link names already filtered (plan КНФ)", async () => {
    const session = cardSession(ACTIVE);
    renderOffice(session, { initialPath: `/shifts?shift=${ACTIVE.id}&box=046006820000015002` });
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(2));
    const tail = within(section("Короба")).getByLabelText("Последние цифры SSCC");
    expect(tail instanceof HTMLInputElement && tail.value).toBe("046006820000015002");
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015002"]);
  });

  it("still opens the old address of a card, `/shifts/:id`, as the drawer over the list, `?box=` with it", async () => {
    const session = cardSession(ACTIVE);
    renderOffice(session, { initialPath: `/shifts/${ACTIVE.id}?box=046006820000015002` });
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    // The list stays behind it, and the boxes are open and filtered.
    expect(screen.getByRole("heading", { name: "Смены" })).toBeTruthy();
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(2));
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015002"]);
  });

  it("opens from a row of the list, keeps the list behind, closes with Escape and gives the focus back to the row", async () => {
    const session = cardSession(ACTIVE);
    await openShifts(session);
    const number = screen.getByRole("link", { name: "Карточка смены OCT26-004" });
    number.focus();
    fireEvent.click(number);
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    expect(screen.getByRole("dialog", { name: "Смена OCT26-004" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(number);
    // The row of a closed shift opens it too, by a click on any cell that is no control.
    const row = screen.getByText("OCT26-001/S").closest("tr");
    if (row === null) throw new Error("row");
    fireEvent.click(within(row).getAllByRole("cell")[1] as HTMLElement);
    await waitFor(() =>
      expect(session.api.getShift).toHaveBeenLastCalledWith("office-session-token", CLOSED.id),
    );
  });

  it("says the shift's working day in the header of every tab, and the production date in the summary", async () => {
    const session = cardSession({ ...ACTIVE, plannedDate: "2026-10-12" });
    await openCard(session, "OCT26-004");
    // Beside the status, whatever tab is open.
    expect(screen.getByText("Дата смены: 12.10.2026")).toBeTruthy();
    openTab("Короба");
    expect(screen.getByText("Дата смены: 12.10.2026")).toBeTruthy();
  });

  it("shows the boxes ten to a page", async () => {
    const many = Array.from({ length: 11 }, (_, index) => box(index + 1));
    await openCard(cardSession(ACTIVE, many), "OCT26-004", "Короба");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(11));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015011"]);
  });

  it("has neither boxes nor figures nor exports for a planned shift", async () => {
    const session = cardSession(PLANNED);
    session.api.listShifts.mockResolvedValue([PLANNED]);
    await openCard(session, PLANNED.number);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("region", { name: "Короба" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Итоги" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Выгрузка" })).toBeNull();
    expect(session.api.listShiftBoxes).not.toHaveBeenCalled();
  });

  it("closes an active shift from the card and reads it again, its boxes too", async () => {
    const session = cardSession(ACTIVE);
    const closed: OfficeShift = { ...ACTIVE, status: "closed", closeReasonText: "Сбой линии" };
    session.api.closeShift.mockResolvedValue(closed);
    await openCard(session, "OCT26-004", "Короба");
    await waitFor(() => expect(session.api.listShiftBoxes).toHaveBeenCalledTimes(1));
    session.api.getShift.mockResolvedValue(closed);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const dialog = await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
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
    fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку смены" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Смены" })).toBeTruthy();
  });

  it("names the shift's product, line and counterparty, and its times in the organization's zone", async () => {
    const session = cardSession(WITH_PALLETS);
    // Kamchatka (UTC+12), so the organization's time is no PC's own by chance.
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(facts()["Открыта"]).toBe("08.10.2026, 18:02"));
    expect(facts()).toEqual({
      Товар: "Молоко 3,2% 0,9 л",
      "Дата смены": "08.10.2026",
      "Дата производства": "08.10.2026",
      Линия: "Линия 2",
      Контрагент: "ООО «Северный берег»",
      Режим: "Агрегация",
      "План, шт": "1\u00a0200",
      "Вместимость короба, шт": "12",
      "Шаблон этикетки короба": "Молоко 100×72",
      Паллеты: "По 40 кор.",
      "Шаблон паллеты": "Паллета 100×150",
      "Лист паллеты А4": "По умолчанию (стандартный лист)",
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

  it("shows a validation shift as «Проверка» with the codes it accepted, and without boxes or pallets (plan РЕЖ, Р11)", async () => {
    const validation: OfficeShift = {
      ...ACTIVE,
      mode: "validation",
      totals: {
        ...ACTIVE.totals,
        acceptedUnits: 1300,
        unitsInClosedBoxes: 0,
        closedBoxes: 0,
        openBoxes: 0,
      },
    };
    const session = cardSession(validation, []);
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(session.api.getShift).toHaveBeenCalled());
    expect(facts()["Режим"]).toBe("Проверка");
    expect(facts()["Выпуск"]).toBe("1\u00a0300 шт");
    expect(facts()).not.toHaveProperty("Вместимость короба, шт");
    expect(facts()).not.toHaveProperty("Паллеты");
    expect(screen.queryByRole("region", { name: "Короба" })).toBeNull();
    expect(session.api.listShiftBoxes).not.toHaveBeenCalled();
    // Its figures and exports stay.
    expect(screen.getByRole("tab", { name: "Итоги" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Выгрузки" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Выгрузка" })).toBeTruthy();
  });

  describe("a validation shift that prints a duplicate (plan РЕЖ part B, B7)", () => {
    const printing = (verification: "none" | "required"): OfficeShift => ({
      ...ACTIVE,
      mode: "validation",
      validationPrint: {
        mode: "duplicate_dm",
        templateId: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
        verification,
      },
      totals: {
        ...ACTIVE.totals,
        acceptedUnits: 318,
        unitsInClosedBoxes: 0,
        closedBoxes: 0,
        openBoxes: 0,
        unitLabels: { sent: 321, verified: 300, skipped: 4, unresolved: 2, reprints: 3 },
      },
    });

    /** «Контроль печати»'s figures as term to description. */
    function printFacts(): Record<string, string> {
      return Object.fromEntries(
        within(section("Контроль печати"))
          .getAllByRole("term")
          .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
      );
    }

    it("says the duplicate is printed and whether its check is required", async () => {
      await openCard(cardSession(printing("required"), []), "OCT26-004");
      expect(facts()["Печать дубликата"]).toBe("Включена, проверка обязательна");
    });

    it("counts the labels in «Контроль печати», in the cloud's words, and says when some need finishing", async () => {
      await openCard(cardSession(printing("none"), []), "OCT26-004");
      expect(facts()["Печать дубликата"]).toBe("Включена, проверка необязательна");
      expect(printFacts()).toEqual({
        "Отправки на принтер": "321",
        "Проверенные этикетки": "300",
        "Пропущенные проверки": "4",
        "Требуют завершения": "2",
        "Повторные попытки": "3",
      });
      expect(
        within(section("Контроль печати")).getByText(
          "Отправка на принтер не подтверждает физическую печать. Проверка учитывается только после сканирования этикетки.",
        ),
      ).toBeTruthy();
      expect(
        within(section("Контроль печати")).getByText("Есть этикетки, которые требуют внимания"),
      ).toBeTruthy();
    });

    it("says nothing needs finishing when every label is resolved", async () => {
      const shift = printing("none");
      const resolved: OfficeShift = {
        ...shift,
        totals: {
          ...shift.totals,
          unitLabels: { sent: 10, verified: 0, skipped: 0, unresolved: 0, reprints: 0 },
        },
      };
      await openCard(cardSession(resolved, []), "OCT26-004");
      expect(printFacts()["Требуют завершения"]).toBe("0");
      expect(
        within(section("Контроль печати")).queryByText("Есть этикетки, которые требуют внимания"),
      ).toBeNull();
    });

    it("has no «Контроль печати» for a planned shift, nor for one that does not print, which says so", async () => {
      const planned: OfficeShift = {
        ...PLANNED,
        mode: "validation",
        validationPrint: {
          mode: "duplicate_dm",
          templateId: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
          verification: "none",
        },
      };
      const session = cardSession(planned, []);
      session.api.listShifts.mockResolvedValue([planned]);
      await openCard(session, PLANNED.number);
      expect(facts()["Печать дубликата"]).toBe("Включена, проверка необязательна");
      expect(screen.queryByRole("region", { name: "Контроль печати" })).toBeNull();
    });

    it("says a validation shift without the duplicate prints none, and an aggregation has no such row", async () => {
      const validation: OfficeShift = { ...ACTIVE, mode: "validation" };
      const view = await openCardView(cardSession(validation, []), "OCT26-004");
      expect(facts()["Печать дубликата"]).toBe("Выключена");
      expect(screen.queryByRole("region", { name: "Контроль печати" })).toBeNull();
      view.unmount();
      await openCard(cardSession(ACTIVE), "OCT26-004");
      expect(facts()).not.toHaveProperty("Печать дубликата");
    });
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
    await openCard(cardSession(WITH_PALLETS, BOXES, [apart]), "OCT26-004", "Паллеты");
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
    await openCard(cardSession(WITH_PALLETS, [], pallets), "OCT26-004", "Паллеты");
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(5));
    expect(rowsOf("Паллеты").map((row) => row[4])).toEqual([
      "✓Закрыта",
      "✓Закрыта",
      "✓Закрыта!Счёт коробов станции другой",
      "✓Закрыта!Счёт коробов станции другой",
    ]);
  });

  it("shows a closed pallet's difference as neutral «Состав изменён расформированием» when a taken-apart box accounts for it, and says in plain words what the numbers are", async () => {
    const repacked: OfficePallet = {
      ...PALLET_1,
      boxes: 1,
      boxCountReported: 2,
      disassembledBoxes: 1,
    };
    const real: OfficePallet = {
      ...PALLET_1,
      id: "a0000000-0000-4000-8000-000000000103",
      sscc: "146006820000000403",
      boxes: 1,
      boxCountReported: 3,
      disassembledBoxes: 1,
    };
    await openCard(cardSession(WITH_PALLETS, [], [repacked, real]), "OCT26-004", "Паллеты");
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(3));
    expect(rowsOf("Паллеты").map((row) => row[4])).toEqual([
      "✓Закрыта·Состав изменён расформированием",
      "✓Закрыта!Счёт коробов станции другой",
    ]);
    const neutral = screen.getByText("Состав изменён расформированием").closest("[title]");
    const note =
      "Станция насчитала при закрытии коробов: 2, в базе хоста сейчас: 1. После расформирования коробов числа расходятся (расформировано: 1). Это не ошибка.";
    expect(neutral?.getAttribute("title")).toBe(note);
    expect(neutral?.getAttribute("aria-description")).toBe(note);
    // The other is a warning that says the disassembly does not account for all of it.
    expect(
      screen.getByText("Счёт коробов станции другой").closest("[title]")?.getAttribute("title"),
    ).toBe(
      "Станция насчитала при закрытии коробов: 3, в базе хоста сейчас: 1. Расформирование объясняет не всё расхождение (расформировано: 1): проверьте состав паллеты.",
    );
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
    await openCard(cardSession(WITH_PALLETS, boxes), "OCT26-004", "Короба");
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
    const many = Array.from({ length: 25 }, (_, index) => parity(index + 1));
    await openCard(cardSession(ACTIVE, many), "OCT26-004", "Короба");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(11));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба")[0]?.[0]).toBe("(00)046006820000000111");
    // 12 boxes end with 0: two pages, and the typing starts the first again.
    fireEvent.change(within(section("Короба")).getByLabelText("Последние цифры SSCC"), {
      target: { value: "0" },
    });
    expect(screen.getByText("Показано 12 из 25")).toBeTruthy();
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
    // «Итоги» is the first section: the figures stand on the card, not in a window of their own.
    expect(await within(section("Итоги")).findByText("Принято кодов")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выгрузка" }));
    await screen.findByRole("dialog", { name: "Выгрузка смены OCT26-001/S" });
    expect(session.api.getShiftExportSource).toHaveBeenCalledWith(
      "office-session-token",
      CLOSED.id,
    );
  });

  it("lists the exports saved from the shift, newest first, in the format's name, when the tab is opened", async () => {
    const session = cardSession(CLOSED);
    session.api.listShifts.mockResolvedValue([CLOSED]);
    session.api.listShiftExports.mockResolvedValue(
      officeShiftExportsSchema.parse(fixture("office-shift-exports.json")),
    );
    await openCard(session, CLOSED.number);
    expect(session.api.listShiftExports).not.toHaveBeenCalled();
    openTab("Выгрузки");
    await within(section("Выгрузки смены")).findByRole("table");
    await waitFor(() =>
      expect(within(section("Выгрузки смены")).getAllByRole("row")).toHaveLength(3),
    );
    const rows = rowsOf("Выгрузки смены");
    // The export's own cells; the format's holds, under its name, the files the host kept.
    expect(rows.map((cells) => [cells[0], ...cells.slice(2)])).toEqual([
      ["08.10.2026, 10:30", "3", "2", "1", "3", "Иван Петров"],
      ["08.10.2026, 10:10", "0", "1", "1", "1", "—"],
    ]);
    expect(rows[0]?.[1]).toContain("[XML][ГИСМТ] Паллетная агрегацияНе больше 2 строк в части");
    expect(rows[0]?.[1]).toContain("Скачать все (2)");
    // An export from before files were kept says so.
    expect(rows[1]?.[1]).toBe(
      "[XML][ГИСМТ] Агрегация паллетыПаллетыФайл не сохранён: сформируйте выгрузку заново",
    );
    expect(session.api.listShiftExports).toHaveBeenCalledWith("office-session-token", CLOSED.id);
  });

  it("says a shift with no saved exports so, and when the history did not load, with a retry", async () => {
    const session = cardSession(CLOSED);
    session.api.listShifts.mockResolvedValue([CLOSED]);
    session.api.listShiftExports.mockRejectedValueOnce(lost());
    await openCard(session, CLOSED.number, "Выгрузки");
    const exports = section("Выгрузки смены");
    fireEvent.click(await within(exports).findByRole("button", { name: "Повторить" }));
    expect(await within(exports).findByText("Из этой смены ещё ничего не выгружали")).toBeTruthy();
  });

  it("says when the boxes or the pallets did not load, each in its own place, and loads them again", async () => {
    const session = cardSession(WITH_PALLETS);
    session.api.listShiftBoxes.mockRejectedValueOnce(lost());
    session.api.listShiftPallets.mockRejectedValue(lost());
    await openCard(session, "OCT26-004", "Короба");
    const boxes = await waitFor(() => {
      const region = section("Короба");
      expect(within(region).getByRole("button", { name: "Повторить" })).toBeTruthy();
      return region;
    });
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
    // And «Паллеты» says so in its own place.
    openTab("Паллеты");
    expect(
      await within(section("Паллеты")).findByRole("button", { name: "Повторить" }),
    ).toBeTruthy();
  });

  it("links a box's and a pallet's SSCC to their cards (plan КРТ)", async () => {
    const session = cardSession(WITH_PALLETS);
    session.api.getBoxCard.mockResolvedValue(BOX_CARD);
    session.api.getPalletCard.mockResolvedValue(PALLET_CARD);
    await openCard(session, "OCT26-004", "Короба");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    const boxLink = within(section("Короба")).getByRole("link", { name: "(00)046006820000015001" });
    expect(boxLink.getAttribute("href")).toBe("/codes/box/b0000000-0000-4000-8000-000000000001");
    const palletLinks = within(section("Короба")).getAllByRole("link", {
      name: "(00)146006820000000409",
    });
    expect(palletLinks[0]?.getAttribute("href")).toBe(
      "/codes/pallet/a0000000-0000-4000-8000-000000000001",
    );
    openTab("Паллеты");
    const own = await within(section("Паллеты")).findByRole("link", {
      name: "(00)146006820000000409",
    });
    expect(own.getAttribute("href")).toBe("/codes/pallet/a0000000-0000-4000-8000-000000000001");
    openTab("Короба");
    fireEvent.click(
      await within(section("Короба")).findByRole("link", { name: "(00)046006820000015001" }),
    );
    await screen.findByRole("heading", { name: "Короб (00)046006820000015000" });
    expect(session.api.getBoxCard).toHaveBeenCalledWith(
      "office-session-token",
      "b0000000-0000-4000-8000-000000000001",
    );
  });

  it("opens a pallet's card from the pallet's SSCC, not the box's (plan КРТ)", async () => {
    const session = cardSession(WITH_PALLETS);
    session.api.getPalletCard.mockResolvedValue(PALLET_CARD);
    await openCard(session, "OCT26-004", "Паллеты");
    fireEvent.click(
      await within(section("Паллеты")).findByRole("link", { name: "(00)146006820000000409" }),
    );
    await screen.findByRole("heading", { name: "Паллета (00)146006820000000409" });
    expect(session.api.getPalletCard).toHaveBeenCalledWith(
      "office-session-token",
      "a0000000-0000-4000-8000-000000000001",
    );
  });

  it("names the pallet of a box, says when it is not among the shift's pallets, and says it is not read yet", async () => {
    const stray = box(5, { palletId: "a0000000-0000-4000-8000-0000000000ff" });
    const session = cardSession(WITH_PALLETS, [BOXES[0] as OfficeBox, stray], [PALLET_1]);
    await openCard(session, "OCT26-004", "Короба");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(3));
    expect(rowsOf("Короба").map((row) => row[3])).toEqual([
      "(00)146006820000000409",
      "Паллета не найдена",
    ]);
  });

  it("does not call a pallet missing while the pallets are still coming", async () => {
    const session = cardSession(WITH_PALLETS);
    session.api.listShiftPallets.mockReturnValue(new Promise(() => undefined));
    await openCard(session, "OCT26-004", "Короба");
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
    await openCard(cardSession(ACTIVE, boxes), "OCT26-004", "Короба");
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
      Array.from({ length: 11 }, (_, index) => box(index + 1)),
    );
    const closed: OfficeShift = { ...ACTIVE, status: "closed", closeReasonText: "Сбой линии" };
    session.api.closeShift.mockResolvedValue(closed);
    await openCard(session, "OCT26-004", "Короба");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(11));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба")).toHaveLength(1);
    session.api.getShift.mockResolvedValue(closed);
    session.api.listShiftBoxes.mockResolvedValue(BOXES.slice(0, 3));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const dialog = await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
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
    const dialog = await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Сбой линии" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));
    const reads = session.api.getShift.mock.calls.length;
    fireEvent.click(await within(dialog).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Закрыть смену OCT26-004" })).toBeNull(),
    );
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
      disassembledBoxes: 0,
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

  it("tells a difference a disassembly accounts for from a real one (the owner's repacking, plan КРТ-4)", () => {
    const pallet = {
      closedAt: "2026-10-08T06:20:44.650Z",
      disassembledAt: null,
      boxes: 1,
      boxCountReported: 2,
      disassembledBoxes: 1,
    };
    // Two boxes at the close, one taken apart since: the composition changed legitimately.
    expect(palletCountState(pallet)).toBe("explained");
    expect(palletCountDiffers(pallet)).toBe(false);
    // The disassembly has to be the whole difference.
    expect(palletCountState({ ...pallet, disassembledBoxes: 0 })).toBe("differs");
    expect(palletCountState({ ...pallet, disassembledBoxes: 2 })).toBe("differs");
    expect(palletCountState({ ...pallet, boxes: 0, disassembledBoxes: 1 })).toBe("differs");
    // Nothing to explain when the counts agree, none was counted, or the pallet is not closed.
    expect(palletCountState({ ...pallet, boxes: 2, disassembledBoxes: 1 })).toBe("same");
    expect(palletCountState({ ...pallet, boxCountReported: null })).toBe("same");
    expect(palletCountState({ ...pallet, closedAt: null })).toBe("same");
    expect(palletCountState({ ...pallet, disassembledAt: "2026-10-08T07:00:00.000Z" })).toBe(
      "same",
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
