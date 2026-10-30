import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { DeviceRecord, OfficeShift } from "../src/host/protocol.js";
import { ORG_PROFILE, TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  CLOSED,
  freezeToday,
  NO_TOTALS,
  openShifts,
  shiftRow,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";

/** The station that opened the active shift. */
const STATION: DeviceRecord = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  name: "Станция линии 2",
  lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: "2026-10-08T09:41:00Z",
  revokedAt: null,
};
/** A station that worked on the shift and was revoked since. */
const OLD_STATION: DeviceRecord = {
  ...STATION,
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  name: "Старая станция",
  revokedAt: "2026-10-08T12:00:00Z",
};
/** A device the list of devices does not have. */
const UNLISTED_ID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";

/** The active shift with three devices: listed, revoked and unlisted. */
const DETAIL: OfficeShift = {
  ...ACTIVE,
  totals: { ...ACTIVE.totals, deviceIds: [STATION.id, OLD_STATION.id, UNLISTED_ID] },
};

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Итоги смены OCT26-004" });
}

/** The figures as term → description. */
function figures(): Record<string, string | null> {
  return Object.fromEntries(
    within(dialog())
      .getAllByRole("term")
      .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? null]),
  );
}

/** The devices of the shift, one name per line. */
function deviceNames(): (string | null)[] {
  const term = within(dialog())
    .getAllByRole("term")
    .find((each) => each.textContent === "Устройства смены");
  const list = term?.nextElementSibling?.firstElementChild;
  return Array.from(list?.children ?? []).map((line) => line.textContent);
}

async function openTotals(session: FakeOfficeSession): Promise<RenderResult> {
  const view = await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
  await screen.findByRole("dialog", { name: "Итоги смены OCT26-004" });
  await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(7));
  return view;
}

/** How this PC writes `instant`, with no time zone named. */
function pcTime(instant: string): string {
  return new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(instant),
  );
}

describe("office shifts: a shift's figures", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers the figures of an active and a closed shift to both roles, and none of a planned one", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      expect(screen.getByRole("button", { name: "Итоги смены OCT26-004" })).toBeTruthy();
      expect(
        within(shiftRow(CLOSED.number)).getByRole("button", { name: "Итоги смены OCT26-001/S" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Итоги смены OCT26-005" })).toBeNull();
      view.unmount();
    }
  });

  it("reads the shift when the dialog opens and shows its figures, the last fact in the organization's time and the devices by name", async () => {
    const session = shiftsSession();
    // Kamchatka (UTC+12), so the organization's time is no PC's own by chance.
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    session.api.getShift.mockResolvedValue(DETAIL);
    session.api.listDevices.mockResolvedValue([OLD_STATION, STATION]);
    await openTotals(session);
    expect(session.api.getShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id);
    expect(figures()).toEqual({
      // A no-break space between the thousands.
      "План, шт": "1\u00a0200",
      "Принято кодов": "547",
      "Кодов в закрытых коробах": "540",
      "Закрыто коробов": "45",
      "Открыто коробов": "1",
      // 09:41 UTC on 8 October is 21:41 the same day in Kamchatka.
      "Последние данные со станции": "08.10.2026, 21:41",
      "Устройства смены": "Станция линии 2Старая станция (отозвано)Устройство 0f1e2d3c…",
    });
    expect(deviceNames()).toEqual([
      "Станция линии 2",
      "Старая станция (отозвано)",
      "Устройство 0f1e2d3c…",
    ]);
    expect(within(dialog()).queryByText(/по часам этого ПК/)).toBeNull();
    expect(within(dialog()).queryByText(/началами кодов/)).toBeNull();
  });

  it("shows a technologist the devices by the start of their ids and says why, without asking for the list", async () => {
    const session = shiftsSession(undefined, TECHNOLOGIST);
    session.api.getShift.mockResolvedValue(DETAIL);
    await openTotals(session);
    expect(deviceNames()).toEqual([
      "Устройство 7c9e6679…",
      "Устройство 4d5e6f7a…",
      "Устройство 0f1e2d3c…",
    ]);
    expect(
      within(dialog()).getByText(
        "Названия устройств видит только администратор: устройства показаны началами кодов.",
      ),
    ).toBeTruthy();
    expect(session.api.listDevices).not.toHaveBeenCalled();
  });

  it("shows the devices by the start of their ids when the list of devices does not load, and says so", async () => {
    const session = shiftsSession();
    session.api.getShift.mockResolvedValue(DETAIL);
    session.api.listDevices.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openTotals(session);
    expect(deviceNames()).toEqual([
      "Устройство 7c9e6679…",
      "Устройство 4d5e6f7a…",
      "Устройство 0f1e2d3c…",
    ]);
    expect(
      within(dialog()).getByText(
        "Список устройств не загрузился. Вместо названий показаны первые символы идентификаторов устройств.",
      ),
    ).toBeTruthy();
  });

  it("says when no fact has arrived and no device has entered yet, and when there is no plan", async () => {
    const session = shiftsSession();
    session.api.getShift.mockResolvedValue({ ...ACTIVE, plannedQty: null, totals: NO_TOTALS });
    session.api.listDevices.mockResolvedValue([STATION]);
    await openTotals(session);
    expect(figures()).toEqual({
      "План, шт": "—",
      "Принято кодов": "0",
      "Кодов в закрытых коробах": "0",
      "Закрыто коробов": "0",
      "Открыто коробов": "0",
      "Последние данные со станции": "Данных ещё нет",
      "Устройства смены": "Ни одно устройство ещё не входило в смену",
    });
  });

  it("writes the time by this PC's clock when the profile does not load or names a zone this PC lacks, and says which", async () => {
    for (const [answer, note] of [
      [
        () =>
          Promise.reject(new HostError({ kind: "transport", code: "unreachable", message: "x" })),
        "Часовой пояс организации не загрузился: время — по часам этого ПК.",
      ],
      [
        () => Promise.resolve({ ...ORG_PROFILE, timeZone: "Mars/Olympus_Mons" }),
        "Этот ПК не знает часовой пояс организации: время — по часам этого ПК.",
      ],
    ] as const) {
      const session = shiftsSession();
      session.api.getOrg.mockImplementation(answer);
      session.api.getShift.mockResolvedValue(ACTIVE);
      session.api.listDevices.mockResolvedValue([STATION]);
      const view = await openTotals(session);
      expect(figures()["Последние данные со станции"]).toBe(pcTime("2026-10-08T09:41:07Z"));
      expect(within(dialog()).getByText(note)).toBeTruthy();
      view.unmount();
    }
  });

  it("keeps the time in the organization's zone while the dialog is open, though the profile read again fails", async () => {
    const session = shiftsSession();
    session.api.getOrg.mockResolvedValueOnce({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    session.api.getShift.mockResolvedValue(ACTIVE);
    session.api.listDevices.mockResolvedValue([STATION]);
    await openTotals(session);
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Закрыть" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The profile is in the cache now; read again at the next opening, it fails.
    session.api.getOrg.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
    await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(7));
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalledTimes(2));
    // Let the failed read settle into the query's state.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(figures()["Последние данные со станции"]).toBe("08.10.2026, 21:41");
    expect(within(dialog()).queryByText(/по часам этого ПК/)).toBeNull();
  });

  it("offers to read the figures again when they do not load, and reads them anew at every opening", async () => {
    const session = shiftsSession();
    session.api.getShift
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValue(ACTIVE);
    session.api.listDevices.mockResolvedValue([STATION]);
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
    fireEvent.click(await within(dialog()).findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(7));
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Закрыть" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
    await waitFor(() => expect(session.api.getShift).toHaveBeenCalledTimes(3));
  });

  it("writes every count with its thousands apart", async () => {
    const session = shiftsSession();
    session.api.getShift.mockResolvedValue({
      ...ACTIVE,
      totals: {
        ...ACTIVE.totals,
        acceptedUnits: 12_010,
        unitsInClosedBoxes: 12_000,
        closedBoxes: 1000,
        openBoxes: 1100,
      },
    });
    session.api.listDevices.mockResolvedValue([STATION]);
    await openTotals(session);
    const shown = figures();
    expect(shown["Принято кодов"]).toBe("12\u00a0010");
    expect(shown["Кодов в закрытых коробах"]).toBe("12\u00a0000");
    expect(shown["Закрыто коробов"]).toBe("1\u00a0000");
    expect(shown["Открыто коробов"]).toBe("1\u00a0100");
  });

  it("adds no note about the time or the devices to a shift that has none", async () => {
    const down = () => new HostError({ kind: "transport", code: "unreachable", message: "x" });
    // A technologist, the profile not loading: no time, so nothing to say about it.
    const first = shiftsSession(undefined, TECHNOLOGIST);
    first.api.getOrg.mockRejectedValue(down());
    first.api.getShift.mockResolvedValue({ ...ACTIVE, totals: NO_TOTALS });
    const view = await openTotals(first);
    expect(figures()["Последние данные со станции"]).toBe("Данных ещё нет");
    expect(within(dialog()).queryByText(/по часам этого ПК/)).toBeNull();
    expect(within(dialog()).queryByText(/Названия устройств/)).toBeNull();
    view.unmount();
    // An administrator, the list of devices not loading: no devices, so nothing to name.
    const second = shiftsSession();
    second.api.listDevices.mockRejectedValue(down());
    second.api.getShift.mockResolvedValue({ ...ACTIVE, totals: NO_TOTALS });
    await openTotals(second);
    expect(figures()["Устройства смены"]).toBe("Ни одно устройство ещё не входило в смену");
    expect(within(dialog()).queryByText(/Список устройств не загрузился/)).toBeNull();
  });

  it("shows no figures of the shift opened before while its own are read", async () => {
    const session = shiftsSession();
    let answer: (shift: OfficeShift) => void = () => undefined;
    session.api.getShift.mockImplementation((_token, id) =>
      id === ACTIVE.id
        ? Promise.resolve(DETAIL)
        : new Promise<OfficeShift>((resolve) => {
            answer = resolve;
          }),
    );
    session.api.listDevices.mockResolvedValue([STATION]);
    await openTotals(session);
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Закрыть" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(
      within(shiftRow(CLOSED.number)).getByRole("button", { name: "Итоги смены OCT26-001/S" }),
    );
    const closed = await screen.findByRole("dialog", { name: "Итоги смены OCT26-001/S" });
    await waitFor(() => expect(session.api.getShift).toHaveBeenCalledTimes(2));
    expect(within(closed).queryAllByRole("term")).toEqual([]);
    await act(async () => {
      answer(CLOSED);
    });
    await waitFor(() => expect(within(closed).getAllByRole("term")).toHaveLength(7));
    expect(within(closed).getAllByText("492")).toHaveLength(2);
  });

  it("shows only the loading until the profile and the list of devices have both answered, whichever is first", async () => {
    for (const first of ["profile", "devices"] as const) {
      const session = shiftsSession();
      let answerOrg: (org: typeof ORG_PROFILE) => void = () => undefined;
      let answerDevices: (devices: DeviceRecord[]) => void = () => undefined;
      session.api.getOrg.mockImplementation(
        () =>
          new Promise<typeof ORG_PROFILE>((resolve) => {
            answerOrg = resolve;
          }),
      );
      session.api.getShift.mockResolvedValue(DETAIL);
      session.api.listDevices.mockImplementation(
        () =>
          new Promise<DeviceRecord[]>((resolve) => {
            answerDevices = resolve;
          }),
      );
      const view = await openShifts(session);
      fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
      await screen.findByRole("dialog", { name: "Итоги смены OCT26-004" });
      await waitFor(() => expect(session.api.getShift).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(session.api.getOrg).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(session.api.listDevices).toHaveBeenCalledTimes(1));
      // The figures have arrived; one of the two has not: the dialog waits for both.
      await act(async () => {
        if (first === "profile") answerOrg({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
        else answerDevices([OLD_STATION, STATION]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(within(dialog()).queryAllByRole("term"), first).toEqual([]);
      await act(async () => {
        if (first === "profile") answerDevices([OLD_STATION, STATION]);
        else answerOrg({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
      });
      await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(7));
      expect(figures()["Последние данные со станции"]).toBe("08.10.2026, 21:41");
      expect(deviceNames()[0]).toBe("Станция линии 2");
      view.unmount();
    }
  });

  it("closes from its own button as well as from the cross", async () => {
    const session = shiftsSession();
    session.api.getShift.mockResolvedValue(ACTIVE);
    session.api.listDevices.mockResolvedValue([STATION]);
    await openTotals(session);
    const buttons = within(dialog()).getAllByRole("button", { name: "Закрыть" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a validation shift's accepted codes and no box figures, in the dialog and in the list (plan РЕЖ, Р11)", async () => {
    // The host counts a validation shift's codes in no box; its box counts are 0.
    const validation: OfficeShift = {
      ...ACTIVE,
      mode: "validation",
      totals: {
        ...ACTIVE.totals,
        acceptedUnits: 1300,
        unitsInClosedBoxes: 0,
        closedBoxes: 0,
        openBoxes: 0,
        deviceIds: [STATION.id],
      },
    };
    const session = shiftsSession([validation]);
    session.api.getShift.mockResolvedValue(validation);
    session.api.listDevices.mockResolvedValue([STATION]);
    await openShifts(session);
    // «Выпуск»: the codes it accepted, never «0 шт · 0 кор.».
    expect(
      shiftRow(validation.number).querySelector(".shift-cell--end > span:first-child")?.textContent,
    ).toBe("1\u00a0300 шт");
    fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
    await screen.findByRole("dialog", { name: "Итоги смены OCT26-004" });
    await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(4));
    expect(figures()).toEqual({
      "План, шт": "1\u00a0200",
      "Принято кодов": "1\u00a0300",
      "Последние данные со станции": expect.stringMatching(/^08\.10\.2026, \d\d:41$/),
      "Устройства смены": "Станция линии 2",
    });
  });
});
