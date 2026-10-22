import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DeviceRecord } from "../src/host/protocol.js";
import { stationShift } from "../src/office/devices/station-shift.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { pressRowAction } from "./support/row-menu.js";
import { chooseValue } from "./support/select.js";
import {
  ACTIVE,
  HANDHELD_ID,
  LINE_10,
  LINE_2,
  participant,
  PARTICIPANT_A,
  PARTICIPANT_B,
  SHARED,
  STATION_ID,
} from "./support/shifts.js";

const STATION: DeviceRecord = {
  id: STATION_ID,
  kind: "station",
  name: "Станция линии 1",
  lineId: LINE_2.id,
  appVersion: "1.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: "2026-10-08T09:41:00Z",
  revokedAt: null,
};
const HANDHELD: DeviceRecord = {
  ...STATION,
  id: HANDHELD_ID,
  kind: "handheld",
  name: "ТСД 1",
  lineId: null,
};
const SECOND_ID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const SECOND: DeviceRecord = { ...STATION, id: SECOND_ID, name: "Станция 2" };
const IDLE: DeviceRecord = {
  ...STATION,
  id: "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e",
  name: "Станция упаковки",
  lineId: LINE_10.id,
};

function session(shifts = [SHARED], devices = [STATION, HANDHELD, IDLE]): FakeOfficeSession {
  const fake = fakeOfficeSession();
  fake.api.listDevices.mockResolvedValue(devices);
  fake.api.listLines.mockResolvedValue([{ ...LINE_2, maxStations: 3 }, LINE_10]);
  fake.api.listShifts.mockResolvedValue(shifts);
  return fake;
}

async function openDevices(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake, { initialPath: "/devices" });
  await screen.findByRole("link", { name: "Устройства" });
  await screen.findByText("Станция линии 1");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("the devices' participation in a shift (plan 2b)", () => {
  it("says under a device's line that it works the shift, for a station and a handheld alike", async () => {
    await openDevices(session());
    await waitFor(() => expect(within(rowOf("ТСД 1")).getByText("В смене OCT26-004")).toBeTruthy());
    expect(within(rowOf("Станция линии 1")).getByText("В смене OCT26-004")).toBeTruthy();
    expect(within(rowOf("Станция линии 1")).getByText("Линия 2")).toBeTruthy();
    expect(within(rowOf("Станция упаковки")).queryByText(/смене/)).toBeNull();
  });

  it("does not say a revoked device works the shift: the host frees its slot", async () => {
    const revoked = { ...STATION, revokedAt: "2026-10-08T12:00:00Z" };
    await openDevices(session([SHARED], [revoked, HANDHELD, IDLE]));
    await waitFor(() => expect(within(rowOf("ТСД 1")).getByText("В смене OCT26-004")).toBeTruthy());
    expect(within(rowOf("Станция линии 1")).queryByText(/смене/)).toBeNull();
  });

  it("tells a paused device and one that closed its part from one at work, in a word and a glyph", async () => {
    const shift = {
      ...SHARED,
      participants: [
        participant({ state: "left" }),
        { ...PARTICIPANT_B, state: "closed" as const, closedBy: "device" as const },
      ],
    };
    await openDevices(session([shift]));
    await waitFor(() =>
      expect(within(rowOf("Станция линии 1")).getByText("На паузе в смене OCT26-004")).toBeTruthy(),
    );
    expect(within(rowOf("ТСД 1")).getByText("Часть закрыта в смене OCT26-004")).toBeTruthy();
    expect(within(rowOf("Станция линии 1")).getByText("·")).toBeTruthy();
    expect(within(rowOf("ТСД 1")).getByText("✓")).toBeTruthy();
  });

  it("lists the devices as before when the shifts did not load, and claims nothing", async () => {
    const fake = session();
    fake.api.listShifts.mockRejectedValue(new Error("down"));
    await openDevices(fake);
    expect(within(rowOf("Станция линии 1")).queryByText(/смене/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("adds no column: the table keeps its eight, so «Доступ» and the actions stay in view at 1280 px", async () => {
    await openDevices(session());
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Имя", "Вид", "Линия", "Версия", "Подключено", "Связь", "Доступ", "Действия"]);
  });

  it("claims nothing for a shift of a host before protocol 7", async () => {
    await openDevices(session([{ ...ACTIVE, ownerDeviceId: STATION_ID }]));
    expect(within(rowOf("Станция линии 1")).queryByText(/смене/)).toBeNull();
  });
});

describe("the warning before a station moves, by the shift it works (plan 2b)", () => {
  const warning = /^На станции идёт смена OCT26-004\./;
  const sharedWarning =
    /^На станции идёт общая смена OCT26-004: в ней работают и другие устройства\./;

  /** Opens a station's dialog once the table shows what the shifts say of it, and picks another line. */
  async function openMove(
    fake: FakeOfficeSession,
    name: string,
    settled: () => Promise<unknown>,
  ): Promise<HTMLElement> {
    await openDevices(fake);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: `Изменить устройство «${name}»` }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(fake.api.listShifts).toHaveBeenCalled());
    chooseValue("Линия", LINE_10.id);
    return dialog;
  }

  it("warns the station that joined a shift it did not open", async () => {
    const shift = {
      ...SHARED,
      participants: [PARTICIPANT_A, participant({ deviceId: SECOND_ID, deviceName: "Станция 2" })],
    };
    const dialog = await openMove(session([shift], [STATION, SECOND]), "Станция 2", () =>
      within(rowOf("Станция 2")).findByText("В смене OCT26-004"),
    );
    // Two devices work it: the warning is the shared shift's, not the lone station's.
    expect(await within(dialog).findByText(sharedWarning)).toBeTruthy();
    expect(within(dialog).queryByText(warning)).toBeNull();
  });

  it("warns a lone station in the plain words, and a station of a shared shift that its part stays open", async () => {
    const alone = { ...SHARED, participants: [PARTICIPANT_A] };
    const plain = await openMove(
      session([alone], [STATION, HANDHELD, IDLE]),
      "Станция линии 1",
      () => within(rowOf("Станция линии 1")).findByText("В смене OCT26-004"),
    );
    expect(await within(plain).findByText(warning)).toBeTruthy();
    expect(within(plain).queryByText(sharedWarning)).toBeNull();
  });

  it("tells the station of a shared shift that its part stays open, pausing, and blocks the shift's own close", async () => {
    const dialog = await openMove(session([SHARED]), "Станция линии 1", () =>
      within(rowOf("Станция линии 1")).findByText("В смене OCT26-004"),
    );
    expect(
      await within(dialog).findByText(
        "На станции идёт общая смена OCT26-004: в ней работают и другие устройства. После перевода или снятия линии станция доделает начатую работу и выведет оператора, но её часть останется открытой, на паузе, и не даст смене закрыться сама. Закройте смену целиком на странице «Смены»: это закроет и части других устройств.",
      ),
    ).toBeTruthy();
  });

  it("does not warn the opener once it left and another device works the shift", async () => {
    const shift = {
      ...SHARED,
      participants: [{ ...PARTICIPANT_A, state: "left" as const }, PARTICIPANT_B],
    };
    const dialog = await openMove(session([shift]), "Станция линии 1", () =>
      within(rowOf("Станция линии 1")).findByText("На паузе в смене OCT26-004"),
    );
    expect(within(dialog).queryByText(warning)).toBeNull();
  });
});

describe("the warning before a device is revoked, by the shifts it has an open part in (plan 2b)", () => {
  const sentence =
    "Устройство участвует в открытых сменах: OCT26-004. Его часть останется открытой и не даст смене закрыться сама: закройте такую смену целиком на странице «Смены».";

  async function openRevoke(fake: FakeOfficeSession, name: string): Promise<HTMLElement> {
    await openDevices(fake);
    await waitFor(() => expect(fake.api.listShifts).toHaveBeenCalled());
    await within(rowOf("ТСД 1")).findByText(/смене OCT26-004/);
    pressRowAction(within(rowOf(name)), `Отозвать устройство «${name}»`);
    return screen.findByRole("dialog");
  }

  it("names the active shift in which the device has an open part", async () => {
    const dialog = await openRevoke(session(), "ТСД 1");
    expect(within(dialog).getByText(sentence)).toBeTruthy();
  });

  it("names a shift where its part is paused too", async () => {
    const shift = {
      ...SHARED,
      participants: [
        participant({ state: "left" }),
        { ...PARTICIPANT_B, state: "closed" as const, closedBy: "device" as const },
      ],
    };
    const paused = await openRevoke(session([shift]), "Станция линии 1");
    expect(within(paused).getByText(sentence)).toBeTruthy();
  });

  it("says nothing of shifts for a device whose part is closed", async () => {
    const closed = {
      ...SHARED,
      participants: [PARTICIPANT_A, { ...PARTICIPANT_B, state: "closed" as const }],
    };
    const quiet = await openRevoke(session([closed]), "ТСД 1");
    expect(within(quiet).queryByText(/открытых сменах/)).toBeNull();
  });

  it("says nothing while the shifts did not load", async () => {
    const fake = session();
    fake.api.listShifts.mockRejectedValue(new Error("down"));
    await openDevices(fake);
    pressRowAction(within(rowOf("ТСД 1")), "Отозвать устройство «ТСД 1»");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/открытых сменах/)).toBeNull();
  });
});

describe("the shift a station works", () => {
  it("is found by its participation, and by ownership for a host before protocol 7", () => {
    const joined = {
      ...SHARED,
      participants: [PARTICIPANT_A, participant({ deviceId: SECOND_ID })],
    };
    expect(stationShift([joined], SECOND_ID)).toBe(joined);
    expect(stationShift([joined], HANDHELD_ID)).toBeUndefined();
    const older = { ...ACTIVE, ownerDeviceId: STATION_ID };
    expect(stationShift([older], STATION_ID)).toBe(older);
    expect(stationShift(undefined, STATION_ID)).toBeUndefined();
  });
});
