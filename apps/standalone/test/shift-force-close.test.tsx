import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { DeviceRecord, OfficeShift } from "../src/host/protocol.js";
import type { FakeOfficeSession } from "./support/office.js";
import { hasRowAction, pressRowAction } from "./support/row-menu.js";
import {
  ACTIVE,
  expectFocusedNotice,
  HANDHELD_ID,
  STATION_ID,
  openShifts,
  participant,
  PARTICIPANT_A,
  PARTICIPANT_B,
  SHARED,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";
const WHOLE = "Закрыть смену OCT26-004 целиком";
const PLAIN = "Закрыть смену OCT26-004";
const CLOSED_SHARED: OfficeShift = {
  ...SHARED,
  status: "closed",
  closedAt: "2026-10-08T14:10:00Z",
  rev: 72,
};

const device = (id: string, revokedAt: string | null): DeviceRecord => ({
  id,
  kind: "station",
  name: "Станция",
  lineId: null,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: null,
  revokedAt,
});

async function openWhole(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  pressRowAction(screen, WHOLE);
  return screen.findByRole("dialog", { name: WHOLE });
}

function giveReason(dialog: HTMLElement, text: string): void {
  fireEvent.change(within(dialog).getByLabelText("Причина закрытия"), { target: { value: text } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену целиком" }));
}

describe("closing a shared shift from the office (plan 2b)", () => {
  it("offers «целиком» for a shift two devices entered", async () => {
    await openShifts(shiftsSession([SHARED]));
    expect(hasRowAction(screen, WHOLE)).toBe(true);
    expect(hasRowAction(screen, PLAIN)).toBe(false);
  });

  it("keeps the usual close for a shift that is not shared", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    expect(hasRowAction(screen, PLAIN)).toBe(true);
    expect(hasRowAction(screen, WHOLE)).toBe(false);
  });

  it("says it closes the shift for every device and names those that had not closed", async () => {
    const dialog = await openWhole(shiftsSession([SHARED]));
    expect(
      within(dialog).getByText(/^Закрытие в офисе завершает смену для всех устройств сразу/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Не закрыли: Станция линии 1 (работает), ТСД 1 (работает)."),
    ).toBeTruthy();
  });

  it("says a paused device is paused, and leaves out a part that is already closed", async () => {
    const shift: OfficeShift = {
      ...SHARED,
      participants: [
        participant({ state: "closed", closedBy: "device", closedAt: "2026-10-08T09:00:00Z" }),
        { ...PARTICIPANT_B, state: "left" },
        participant({ deviceId: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", deviceName: "Станция 2" }),
      ],
    };
    const dialog = await openWhole(shiftsSession([shift]));
    expect(
      within(dialog).getByText("Не закрыли: ТСД 1 (на паузе), Станция 2 (работает)."),
    ).toBeTruthy();
  });

  it("marks a revoked device that has not closed, and keeps it in the list", async () => {
    const session = shiftsSession([SHARED]);
    session.api.listDevices.mockResolvedValue([
      device(STATION_ID, "2026-10-08T12:00:00Z"),
      device(HANDHELD_ID, null),
    ]);
    const dialog = await openWhole(session);
    expect(
      await within(dialog).findByText(
        "Не закрыли: Станция линии 1 (работает, устройство отозвано), ТСД 1 (работает).",
      ),
    ).toBeTruthy();
  });

  it("names a device by its id when the host sent no name, and claims nothing of revocation while the devices are unread", async () => {
    const shift: OfficeShift = {
      ...SHARED,
      participants: [participant({ deviceName: "" }), PARTICIPANT_B],
    };
    const session = shiftsSession([shift]);
    session.api.listDevices.mockRejectedValue(new Error("down"));
    const dialog = await openWhole(session);
    await waitFor(() => expect(session.api.listDevices).toHaveBeenCalled());
    expect(
      within(dialog).getByText("Не закрыли: Устройство 7c9e6679… (работает), ТСД 1 (работает)."),
    ).toBeTruthy();
  });

  it("shows a device's name as text, never as markup", async () => {
    const shift: OfficeShift = {
      ...SHARED,
      participants: [PARTICIPANT_A, { ...PARTICIPANT_B, deviceName: "<b>ТСД</b> 1" }],
    };
    const dialog = await openWhole(shiftsSession([shift]));
    expect(
      within(dialog).getByText("Не закрыли: Станция линии 1 (работает), <b>ТСД</b> 1 (работает)."),
    ).toBeTruthy();
    expect(dialog.querySelector("b")).toBeNull();
  });

  it("still asks for the reason in words, and sends nothing without it", async () => {
    const session = shiftsSession([SHARED]);
    const dialog = await openWhole(session);
    giveReason(dialog, "  ");
    expect(await within(dialog).findByText("Опишите причину: от 3 до 500 символов")).toBeTruthy();
    expect(session.api.closeShift).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason with the revision the shift was loaded at, and says the shift is closed", async () => {
    const session = shiftsSession([SHARED]);
    session.api.closeShift.mockResolvedValue(CLOSED_SHARED);
    const dialog = await openWhole(session);
    giveReason(dialog, "  Станция Б сломалась ");
    await waitFor(() =>
      expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, SHARED.id, {
        reason: "Станция Б сломалась",
        expectedRev: SHARED.rev,
      }),
    );
    await expectFocusedNotice("Смена OCT26-004 закрыта.");
  });

  it("offers to load the data again when a device closed or joined since, and never retries with the host's revision", async () => {
    const session = shiftsSession([SHARED]);
    session.api.closeShift.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 80 },
      }),
    );
    const dialog = await openWhole(session);
    giveReason(dialog, "Станция Б сломалась");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
  });

  it("opens from the card too, under the same name", async () => {
    const session = shiftsSession([SHARED]);
    await openShifts(session);
    fireEvent.click(screen.getByRole("link", { name: "Карточка смены OCT26-004" }));
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть целиком" }));
    expect(await screen.findByRole("dialog", { name: WHOLE })).toBeTruthy();
  });
});

describe("the preview for a shift one device entered (plan 2b)", () => {
  it("keeps the usual title and still names the device that has not closed", async () => {
    const single: OfficeShift = { ...SHARED, participants: [PARTICIPANT_A] };
    await openShifts(shiftsSession([single]));
    pressRowAction(screen, PLAIN);
    const dialog = await screen.findByRole("dialog", { name: PLAIN });
    expect(within(dialog).getByText("Не закрыли: Станция линии 1 (работает).")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Закрыть смену" })).toBeTruthy();
  });

  it("shows no preview for a shift of a host before protocol 7", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    pressRowAction(screen, PLAIN);
    const dialog = await screen.findByRole("dialog", { name: PLAIN });
    expect(within(dialog).queryByText(/^Не закрыли/)).toBeNull();
  });
});

// A handheld that is not the shift's opener is a full participant: the dialog names it by its own record.
it("names a device that did not open the shift", async () => {
  const shift: OfficeShift = {
    ...SHARED,
    participants: [{ ...PARTICIPANT_A, state: "closed", closedBy: "device" }, PARTICIPANT_B],
  };
  expect(shift.participants?.[1]?.deviceId).toBe(HANDHELD_ID);
  const dialog = await openWhole(shiftsSession([shift]));
  expect(within(dialog).getByText("Не закрыли: ТСД 1 (работает).")).toBeTruthy();
});

it("still lists a revoked device's open part among those that did not close: only the office can close it", async () => {
  const session = shiftsSession([SHARED]);
  session.api.listDevices.mockResolvedValue([
    {
      id: SHARED.participants?.[0]?.deviceId ?? "",
      kind: "station",
      name: "Станция линии 1",
      lineId: null,
      appVersion: "0.1.0",
      pairedAt: "2026-09-26T09:15:00Z",
      lastSeenAt: null,
      revokedAt: "2026-10-08T12:00:00Z",
    },
  ]);
  const dialog = await openWhole(session);
  expect(
    within(dialog).getByText("Не закрыли: Станция линии 1 (работает), ТСД 1 (работает)."),
  ).toBeTruthy();
});
