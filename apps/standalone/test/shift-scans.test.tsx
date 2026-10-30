import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeBox } from "../src/host/protocol.js";
import {
  officeScanHistoryPageSchema,
  shiftScansPath,
  type OfficeScanHistoryItem,
} from "../src/host/review.js";
import { type FakeOfficeSession } from "./support/office.js";
import { chooseText } from "./support/select.js";
import {
  ACTIVE,
  CLOSED,
  freezeToday,
  openShifts,
  PLANNED,
  shiftsSession,
} from "./support/shifts.js";

const STATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_STATION = "8d0f7780-8536-41ef-a55c-f18fd2a01bf8";
const TOKEN = "office-session-token";

function scan(n: number, fields: Partial<OfficeScanHistoryItem> = {}): OfficeScanHistoryItem {
  return {
    id: `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    scannedAt: `2026-10-08T06:${String(60 - n).padStart(2, "0")}:00.000Z`,
    receivedAt: `2026-10-08T06:${String(60 - n).padStart(2, "0")}:02.000Z`,
    deviceId: STATION,
    deviceName: "Станция А",
    operatorName: "Иванов И.",
    verdict: "ok",
    duplicateSource: null,
    gtin14: "04600682000013",
    serialTail: `k3Z${n}`,
    boxId: "b0000000-0000-4000-8000-000000000001",
    boxSscc: "046006820000015000",
    palletId: null,
    palletSscc: null,
    ...fields,
  };
}

const SCANS: OfficeScanHistoryItem[] = [
  scan(1, { verdict: "invalid", gtin14: null, serialTail: null, boxId: null, boxSscc: null }),
  scan(2, { verdict: "duplicate", duplicateSource: "host", boxId: null, boxSscc: null }),
  scan(3, { verdict: "wrong_gtin", gtin14: "04600682000099", boxId: null, boxSscc: null }),
  scan(4, {
    palletId: "a0000000-0000-4000-8000-000000000001",
    palletSscc: "146006820000000409",
    operatorName: null,
  }),
  scan(5, { duplicateSource: null, deviceId: OTHER_STATION, deviceName: "Станция Б" }),
];

function scansSession(
  pages: { items: OfficeScanHistoryItem[]; nextCursor: string | null }[] = [
    { items: SCANS, nextCursor: null },
  ],
): FakeOfficeSession {
  const session = shiftsSession([ACTIVE, PLANNED, CLOSED]);
  let call = 0;
  session.api.listShiftScans.mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    if (page === undefined) throw new Error("no page");
    return page;
  });
  session.api.listShiftBoxes.mockResolvedValue([
    box(1, "046006820000015000"),
    box(2, "046006820000015010"),
  ]);
  session.api.listShiftPallets.mockResolvedValue([]);
  return session;
}

function box(n: number, sscc: string): OfficeBox {
  return {
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    deviceId: STATION,
    sscc,
    openedAt: "2026-10-08T06:05:12.031Z",
    closedAt: "2026-10-08T06:06:01.118Z",
    disassembledAt: null,
    palletId: null,
    units: 12,
    itemCountReported: 12,
    digestMatches: true,
    printVerifiedAt: null,
    printSkippedAt: null,
  };
}

async function openScans(session: FakeOfficeSession): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByText(ACTIVE.number));
  await screen.findByRole("dialog", { name: `Смена ${ACTIVE.number}` });
  fireEvent.click(await screen.findByRole("tab", { name: "Сканирования" }));
  await screen.findByRole("region", { name: "История сканирований" });
}

function rows(): string[][] {
  return within(screen.getByRole("region", { name: "История сканирований" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

beforeEach(() => {
  localStorage.removeItem("markiro.theme");
  freezeToday();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("«Сканирования» of a shift's drawer", () => {
  it("has the tab for an active and a closed shift, not for a planned one", async () => {
    await openShifts(scansSession());
    fireEvent.click(screen.getByText(ACTIVE.number));
    await screen.findByRole("tab", { name: "Сканирования" });
  });

  it("lists the scans newest first with the station, operator, result and its reason, a masked code and the links to the box and pallet", async () => {
    const session = scansSession();
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(session.api.listShiftScans).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {}, null, 10);
    const table = rows();
    // Time, station, operator, result with its reason, code, box, pallet.
    expect(table[0]?.slice(1)).toEqual([
      "Станция А",
      "Иванов И.",
      "✕Не распознанСчитанное не похоже на код маркировки",
      "—",
      "—",
      "—",
    ]);
    expect(table[1]?.[3]).toBe("⧉ДубликатЭтот код уже есть в базе хоста");
    expect(table[2]?.[3]).toBe("✕Другой товарGTIN кода не совпадает с товаром смены");
    expect(table[2]?.[4]).toBe("04600682000099 …k3Z3");
    // Accepted: operator unknown is a dash, the pallet is a link to its card.
    expect(table[3]?.slice(2)).toEqual([
      "—",
      "✓ПринятКод принят в смену",
      "04600682000013 …k3Z4",
      "(00)046006820000015000",
      "(00)146006820000000409",
    ]);
    const link = within(screen.getByRole("region", { name: "История сканирований" })).getAllByRole(
      "link",
      { name: "(00)146006820000000409" },
    )[0];
    expect(link?.getAttribute("href")).toBe("/codes/pallet/a0000000-0000-4000-8000-000000000001");
    // The code is never shown whole: no full serial, only the tail.
    expect(screen.queryByText(/S000001/)).toBeNull();
    // The times are the organization's, written as the other tables write them.
    expect(table[0]?.[0]).toMatch(/^08\.10\.2026/);
  });

  it("says the station's local duplicate in its own words", async () => {
    await openScans(
      scansSession([
        { items: [scan(1, { verdict: "duplicate", duplicateSource: "local" })], nextCursor: null },
      ]),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]?.[3]).toBe("⧉ДубликатСтанция уже сканировала этот код");
  });

  it("says so when the shift has no scans, and when the filters keep none", async () => {
    const session = scansSession([{ items: [], nextCursor: null }]);
    await openScans(session);
    expect(await screen.findByText("Сканирований в этой смене ещё не было")).toBeTruthy();
    chooseText("Результат", "Дубликат");
    expect(await screen.findByText("Сканирований по этим условиям нет")).toBeTruthy();
  });

  /** The host's history of `total` scans, read by cursor and limit as the host reads it. */
  function history(session: FakeOfficeSession, total: number) {
    const all = Array.from({ length: total }, (_, index) => scan(index + 1));
    session.api.listShiftScans.mockImplementation(async (_token, _id, _query, cursor, limit) => {
      const size = limit ?? 50;
      const start = cursor === null ? 0 : Number(cursor.split("~")[0]);
      const next = start + size;
      return {
        items: all.slice(start, next),
        nextCursor:
          next < all.length ? `${String(next)}~c0000000-0000-4000-8000-000000000000` : null,
      };
    });
  }

  it("pages by the cursor with the page size as the limit, reading one page ahead so «Вперёд» always leads somewhere", async () => {
    const session = scansSession();
    history(session, 25);
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(10));
    // The first page and the one after it are read; the limit is the page size.
    await waitFor(() => expect(session.api.listShiftScans).toHaveBeenCalledTimes(2));
    expect(session.api.listShiftScans).toHaveBeenNthCalledWith(1, TOKEN, ACTIVE.id, {}, null, 10);
    expect(session.api.listShiftScans).toHaveBeenNthCalledWith(
      2,
      TOKEN,
      ACTIVE.id,
      {},
      "10~c0000000-0000-4000-8000-000000000000",
      10,
    );
    expect(screen.getByText("Показано 1–10, есть ещё")).toBeTruthy();
    expect(screen.getByText("Страница 1")).toBeTruthy();
    // Forward needs no read now; the page after it is read on the way.
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    await waitFor(() => expect(session.api.listShiftScans).toHaveBeenCalledTimes(3));
    expect(rows()).toHaveLength(10);
    expect(await screen.findByText("Показано 11–20 из 25")).toBeTruthy();
    // The pages already read are kept: «Назад» asks nothing.
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByText("Показано 1–10 из 25")).toBeTruthy();
    expect(session.api.listShiftScans).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(await screen.findByText("Показано 21–25 из 25")).toBeTruthy();
    expect(rows()).toHaveLength(5);
  });

  it("takes the page size from the table's own choice as the request's limit, starts the list again from the first page, and keeps the size", async () => {
    const session = scansSession();
    history(session, 60);
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(10));
    chooseText("Строк на странице: Список сканирований смены", "25");
    await waitFor(() =>
      expect(session.api.listShiftScans).toHaveBeenLastCalledWith(
        TOKEN,
        ACTIVE.id,
        {},
        expect.anything(),
        25,
      ),
    );
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(session.api.listShiftScans).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {}, null, 25);
    expect(localStorage.getItem("markiro.office.pageSize.shift-scans")).toBe("25");
  });

  it("narrows by result and by station (named from the answers) and starts again from the first page", async () => {
    const session = scansSession();
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(5));
    chooseText("Результат", "Дубликат");
    await waitFor(() =>
      expect(session.api.listShiftScans).toHaveBeenLastCalledWith(
        TOKEN,
        ACTIVE.id,
        { result: "duplicate" },
        null,
        10,
      ),
    );
    chooseText("Станция", "Станция Б");
    await waitFor(() =>
      expect(session.api.listShiftScans).toHaveBeenLastCalledWith(
        TOKEN,
        ACTIVE.id,
        { result: "duplicate", device: OTHER_STATION },
        null,
        10,
      ),
    );
  });

  it("finds a box by the digits its SSCC ends with, and says when none or several match", async () => {
    const session = scansSession();
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(5));
    const box = screen.getByLabelText("Короб");
    fireEvent.change(box, { target: { value: "5010" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    await waitFor(() =>
      expect(session.api.listShiftScans).toHaveBeenLastCalledWith(
        TOKEN,
        ACTIVE.id,
        { box: "b0000000-0000-4000-8000-000000000002" },
        null,
        10,
      ),
    );
    fireEvent.change(box, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(await screen.findByText("В смене нет короба с таким окончанием SSCC")).toBeTruthy();
    fireEvent.change(box, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(await screen.findByText("Таких коробов несколько: введите больше цифр")).toBeTruthy();
  });

  it("filters by the end of a serial, applied with «Показать», and refuses characters the shell would not pass", async () => {
    const session = scansSession();
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(5));
    const tail = screen.getByLabelText("Последние символы серийного номера");
    fireEvent.change(tail, { target: { value: "k3Z4" } });
    // Nothing is asked per keystroke.
    expect(session.api.listShiftScans).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    await waitFor(() =>
      expect(session.api.listShiftScans).toHaveBeenLastCalledWith(
        TOKEN,
        ACTIVE.id,
        { q: "k3Z4" },
        null,
        10,
      ),
    );
    fireEvent.change(tail, { target: { value: "k3 Z%" } });
    expect(screen.getByText("Только латинские буквы, цифры и знаки - _ . ~")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Показать" })).toHaveProperty("disabled", true);
  });

  it("asks the days of a period as milliseconds in the organization's zone", async () => {
    const session = scansSession();
    await openScans(session);
    await waitFor(() => expect(rows()).toHaveLength(5));
    fireEvent.click(screen.getByRole("button", { name: "С даты" }));
    fireEvent.click(await screen.findByRole("button", { name: "8 октября 2026" }));
    await waitFor(() => {
      const last = session.api.listShiftScans.mock.calls.at(-1);
      expect(typeof last?.[2].fromMs).toBe("number");
      expect(last?.[2].toMs).toBeUndefined();
    });
  });

  it("shows a failed page with «Повторить» and reads again", async () => {
    const session = scansSession();
    session.api.listShiftScans.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openScans(session);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(rows()).toHaveLength(5));
  });
});

describe("the scan history's wire", () => {
  it("builds a path of plain URL characters, filters in a fixed order, the cursor last", () => {
    expect(shiftScansPath("s1", {}, null)).toBe("/v1/office/shifts/s1/scans");
    expect(
      shiftScansPath(
        "s1",
        { q: "k3Z9", result: "ok", fromMs: 1000, toMs: 2000, device: "d-1", box: "b-1" },
        "1791441630000~c0000000-0000-4000-8000-000000000002",
        50,
      ),
    ).toBe(
      "/v1/office/shifts/s1/scans?result=ok&device=d-1&box=b-1&fromMs=1000&toMs=2000&q=k3Z9&limit=50&cursor=1791441630000~c0000000-0000-4000-8000-000000000002",
    );
  });

  it.each([
    ["a tail with a space", { q: "a b" }],
    ["a tail with a percent sign", { q: "%41" }],
    ["a tail over 32 characters", { q: "a".repeat(33) }],
    ["an upper-case result", { result: "OK" as never }],
  ])("refuses %s before it reaches the shell", (_what, query) => {
    expect(() => shiftScansPath("s1", query, null)).toThrow(RangeError);
  });

  it("refuses a cursor this list did not give", () => {
    expect(() => shiftScansPath("s1", {}, "2026-10-08T06:00:00Z|x")).toThrow(RangeError);
  });

  it("refuses a serial tail longer than four characters in an answer, and an unknown result", () => {
    const page = { items: [scan(1)], nextCursor: null };
    expect(officeScanHistoryPageSchema.safeParse(page).success).toBe(true);
    expect(
      officeScanHistoryPageSchema.safeParse({
        ...page,
        items: [scan(1, { serialTail: "12345" })],
      }).success,
    ).toBe(false);
    expect(
      officeScanHistoryPageSchema.safeParse({
        ...page,
        items: [scan(1, { verdict: "rejected" as never })],
      }).success,
    ).toBe(false);
  });
});
