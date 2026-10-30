import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceRecord } from "../src/host/protocol.js";
import { drawerTabs } from "../src/office/shifts/ShiftDrawer.js";
import {
  ACTIVE,
  openShifts,
  PLANNED,
  shiftRow,
  shiftsSession,
  SHARED,
  SHARED_NO_REASON,
  participant,
  HANDHELD_ID,
  PARTICIPANT_B,
  STATION_ID,
} from "./support/shifts.js";
import type { FakeOfficeSession } from "./support/office.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";

const deviceRecord = (id: string, revokedAt: string | null): DeviceRecord => ({
  id,
  kind: "station",
  name: "Станция",
  lineId: null,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: null,
  revokedAt,
});

/** A session whose host says it is `NOW` (the card measures silence by the host's clock). */
function cardSession(...args: Parameters<typeof shiftsSession>): FakeOfficeSession {
  const session = shiftsSession(...args);
  session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, now: NOW.toISOString() });
  return session;
}

const UNITS = new Intl.NumberFormat("ru");
/** Four minutes after the station last spoke (09:41); the handheld spoke at the same time. */
const NOW = new Date("2026-10-08T09:45:00Z");

async function openCard(session: FakeOfficeSession, number: string, tab?: string): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${number}` }));
  await screen.findByRole("heading", { name: `Смена ${number}` });
  if (tab !== undefined) fireEvent.click(screen.getByRole("tab", { name: tab }));
}

function stationsRows(): string[][] {
  const region = screen.getByRole("region", { name: "Станции смены" });
  return within(region)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

describe("the card's tab of a shift's participants (plan 2b)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a tab only for a shift that names participants", () => {
    expect(drawerTabs(SHARED).slice(0, 2)).toEqual(["summary", "stations"]);
    expect(drawerTabs(SHARED_NO_REASON)).toContain("stations");
    expect(drawerTabs(ACTIVE)).not.toContain("stations");
    expect(drawerTabs({ ...ACTIVE, participants: [] })).not.toContain("stations");
    expect(drawerTabs(PLANNED)).toEqual(["summary"]);
  });

  it("lists each device with its entry, state and its part of the totals", async () => {
    await openCard(cardSession([SHARED]), "OCT26-004", "Станции");
    expect(stationsRows()).toEqual([
      ["Станция линии 1Станция", "08.10.2026, 09:02", "▸Работает", "427", "35"],
      ["ТСД 1ТСД", "08.10.2026, 10:10", "▸Работает", "120", "10"],
    ]);
    // The plan's thousands are apart by a no-break space, which the default matcher folds away.
    const summary = `Принято в смене: 547 · План: ${UNITS.format(1200)} · Часть закрыли: 0 из 2`;
    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent === summary),
    ).toBeTruthy();
  });

  it("names the columns the spec lists: device and kind, entry, state, accepted, boxes (pallets only when the shift has them)", async () => {
    await openCard(cardSession([SHARED]), "OCT26-004", "Станции");
    const region = screen.getByRole("region", { name: "Станции смены" });
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Устройство", "Вход", "Состояние", "Принято", "Коробов"]);
  });

  it("adds the pallets column for a shift with pallets", async () => {
    const withPallets = { ...SHARED, palletsEnabled: true, palletBoxCapacity: 40 };
    const session = cardSession([withPallets]);
    session.api.listShiftPallets.mockResolvedValue([]);
    await openCard(session, "OCT26-004", "Станции");
    const region = screen.getByRole("region", { name: "Станции смены" });
    expect(within(region).getAllByRole("columnheader").at(-1)?.textContent).toBe("Палетов");
  });

  it("marks a participant the host has not heard for more than ten minutes, by the host's clock, with the time it last did", async () => {
    const session = cardSession([SHARED]);
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, now: "2026-10-08T10:00:00Z" });
    await openCard(session, "OCT26-004", "Станции");
    await waitFor(() =>
      expect(stationsRows().map((row) => row[2])).toEqual([
        "!Нет связиСлышали: 08.10.2026, 12:41",
        "!Нет связиСлышали: 08.10.2026, 12:41",
      ]),
    );
  });

  it("does not take this PC's clock for the host's: a PC far ahead marks nobody silent", async () => {
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const session = cardSession([SHARED]);
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, now: NOW.toISOString() });
    await openCard(session, "OCT26-004", "Станции");
    await waitFor(() => expect(session.api.getBackups).toHaveBeenCalled());
    await waitFor(() =>
      expect(stationsRows().map((row) => row[2])).toEqual(["▸Работает", "▸Работает"]),
    );
  });

  it("claims no silence while the host's time is unavailable", async () => {
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const session = cardSession([SHARED]);
    session.api.getBackups.mockRejectedValue(new Error("down"));
    await openCard(session, "OCT26-004", "Станции");
    await waitFor(() => expect(session.api.getBackups).toHaveBeenCalled());
    expect(stationsRows().map((row) => row[2])).toEqual(["▸Работает", "▸Работает"]);
  });

  it("names a device by its id when the host sent no name", async () => {
    const nameless = { ...SHARED, participants: [participant({ deviceName: "" })] };
    await openCard(cardSession([nameless]), "OCT26-004", "Станции");
    expect(stationsRows()[0]?.[0]).toMatch(/^Устройство 7c9e6679….*Станция/);
  });

  it("keeps a revoked device listed, marked, and still not closed: it blocks the automatic close", async () => {
    const session = cardSession([SHARED]);
    session.api.listDevices.mockResolvedValue([
      deviceRecord(STATION_ID, "2026-10-08T12:00:00Z"),
      deviceRecord(HANDHELD_ID, null),
    ]);
    await openCard(session, "OCT26-004", "Станции");
    await waitFor(() => expect(stationsRows()[0]?.[0]).toContain("Устройство отозвано"));
    expect(stationsRows()[1]?.[0]).not.toContain("отозвано");
    expect(stationsRows().map((row) => row[2])).toEqual(["▸Работает", "▸Работает"]);
  });

  it("marks nothing while the devices are unread", async () => {
    await openCard(cardSession([SHARED]), "OCT26-004", "Станции");
    expect(stationsRows()[0]?.[0]).not.toContain("отозвано");
  });

  it("says a paused device is paused, and shows no silence for it", async () => {
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const paused = {
      ...SHARED,
      participants: [
        participant({
          deviceId: HANDHELD_ID,
          state: "left",
          deviceKind: "handheld",
          deviceName: "ТСД 1",
        }),
      ],
    };
    await openCard(cardSession([paused]), "OCT26-004", "Станции");
    expect(stationsRows()[0]?.[2]).toBe("·На паузе");
  });

  it("says who closed each part, when, with how many units, and any data that came after", async () => {
    const closed = {
      ...SHARED_NO_REASON,
      participants: [
        participant({
          state: "closed",
          closedBy: "device",
          closedAt: "2026-10-08T14:10:00Z",
          closedActualQty: 427,
          closedReasonCode: "equipment_stop",
          lateDataAt: "2026-10-08T14:20:00Z",
        }),
        {
          ...PARTICIPANT_B,
          state: "closed" as const,
          closedBy: "office_user" as const,
          closedAt: "2026-10-08T14:10:00Z",
        },
      ],
    };
    await openCard(cardSession([closed]), "OCT26-004", "Станции");
    expect(stationsRows().map((row) => row[2])).toEqual([
      "✓Часть закрытаЗакрыто 08.10.2026, 17:10Принято при закрытии: 427Причина расхождения: Остановка оборудования!Данные после закрытия",
      "✓Закрыто из офисаЗакрыто 08.10.2026, 17:10",
    ]);
  });
});

describe("the participants in the list of shifts (plan 2b)", () => {
  it("adds one quiet line to a shared shift's status: how many devices, how many closed their part", async () => {
    const other = {
      ...SHARED_NO_REASON,
      id: "7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      number: "OCT26-007",
    };
    await openShifts(cardSession([SHARED, other]));
    expect(
      within(shiftRow("OCT26-004")).getAllByText("Устройств: 2, закрыли часть: 0"),
    ).toHaveLength(1);
    expect(within(shiftRow("OCT26-007")).getByText("Устройств: 2, закрыли часть: 2")).toBeTruthy();
  });

  it("marks a shift closed without its reason, in a word as well as a glyph", async () => {
    const other = {
      ...SHARED_NO_REASON,
      id: "7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      number: "OCT26-007",
    };
    await openShifts(cardSession([SHARED, other]));
    expect(within(shiftRow("OCT26-007")).getByText("Причина не указана")).toBeTruthy();
    expect(within(shiftRow("OCT26-004")).queryByText("Причина не указана")).toBeNull();
  });

  it("shows a shift of a host before protocol 7 as it was", async () => {
    await openShifts(cardSession([ACTIVE]));
    expect(within(shiftRow("OCT26-004")).queryByText(/^Устройств:/)).toBeNull();
    expect(within(shiftRow("OCT26-004")).queryByText("Причина не указана")).toBeNull();
  });
});

describe("the card of a shift reads again while the shift is at work", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads an active shift every thirty seconds, so the parts do not go stale", async () => {
    const session = cardSession([SHARED]);
    session.api.getShift.mockResolvedValue(SHARED);
    await openCard(session, "OCT26-004", "Станции");
    await waitFor(() => expect(session.api.getShift).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => expect(session.api.getShift.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("does not poll a closed shift", async () => {
    const session = cardSession([SHARED_NO_REASON]);
    session.api.getShift.mockResolvedValue(SHARED_NO_REASON);
    await openCard(session, "OCT26-004");
    await waitFor(() => expect(session.api.getShift).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.api.getShift).toHaveBeenCalledTimes(1);
  });
});
