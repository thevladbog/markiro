import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DeviceRecord, PairingCode } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice } from "./support/office.js";
import { hasRowAction, pressRowAction } from "./support/row-menu.js";

const TSD: DeviceRecord = {
  id: "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f",
  kind: "handheld",
  name: "ТСД склада",
  lineId: null,
  appVersion: "1.0.0",
  pairedAt: "2026-09-26T10:00:00Z",
  lastSeenAt: null,
  revokedAt: null,
};
const OFFICE: DeviceRecord = {
  ...TSD,
  id: "8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b",
  kind: "office",
  name: "Офис",
};
const GONE: DeviceRecord = {
  ...TSD,
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  name: "Старый ТСД",
  revokedAt: "2026-09-26T12:00:00Z",
};

function code(): PairingCode {
  return {
    id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
    code: "7K3MQ9XV2D",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    payload: `markiro-host:1?h=10.0.0.5&p=45710&f=${"ab".repeat(32)}&c=7K3MQ9XV2D`,
  };
}

async function open(devices: DeviceRecord[] = [TSD, OFFICE, GONE]) {
  const session = fakeOfficeSession();
  session.api.listDevices.mockResolvedValue(devices);
  session.api.listLines.mockResolvedValue([]);
  renderOffice(session, { initialPath: "/devices" });
  await screen.findByText("ТСД склада");
  return session;
}

describe("«Привязать заново» (plan ТСД-Х, task Х6)", () => {
  it("is offered for a live station or handheld, not for an office PC or a revoked device", async () => {
    await open();
    // The re-pairing is an entry of the row's «Ещё» menu.
    expect(hasRowAction(screen, "Привязать заново устройство «ТСД склада»")).toBe(true);
    expect(hasRowAction(screen, /Привязать заново устройство «Офис»/)).toBe(false);
    expect(hasRowAction(screen, /Привязать заново устройство «Старый ТСД»/)).toBe(false);
  });

  it("asks the host for a code of that device and shows it with what the app must do", async () => {
    const session = await open();
    session.api.createDevicePairingCode.mockResolvedValue(code());
    pressRowAction(screen, "Привязать заново устройство «ТСД склада»");
    const dialog = await screen.findByRole("dialog", { name: "Привязать заново: ТСД склада" });
    await waitFor(() =>
      expect(session.api.createDevicePairingCode).toHaveBeenCalledWith(
        "office-session-token",
        TSD.id,
      ),
    );
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(within(dialog).getByText(/Устройство сохранит свои данные/)).toBeTruthy();
    // It is not the dialog of a new device: «Новый код» asks for another code of the same device.
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    await waitFor(() => expect(session.api.createDevicePairingCode).toHaveBeenCalledTimes(2));
    expect(session.api.createPairingCode).not.toHaveBeenCalled();
  });

  it("stays open although a device paired after the code was issued", async () => {
    // A device paired in the future of any code: for a new device's code that closes the dialog.
    const later = { ...OFFICE, pairedAt: new Date(Date.now() + 3_600_000).toISOString() };
    const session = await open([TSD, later]);
    session.api.createDevicePairingCode.mockResolvedValue(code());
    pressRowAction(screen, "Привязать заново устройство «ТСД склада»");
    await screen.findByRole("dialog", { name: "Привязать заново: ТСД склада" });
    expect(screen.queryByText(/подключено\./)).toBeNull();
  });

  it("shows the host's refusal and no code when the host will not make one", async () => {
    const session = await open();
    session.api.createDevicePairingCode.mockRejectedValue(new Error("down"));
    pressRowAction(screen, "Привязать заново устройство «ТСД склада»");
    await waitFor(() => expect(session.api.createDevicePairingCode).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
