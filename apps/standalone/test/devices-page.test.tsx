import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { DeviceRecord, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const FINGERPRINT = "ab".repeat(32);
const HOST_PC: DeviceRecord = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  name: "Рабочее место хоста",
  lineId: LINE_ID,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: "2026-09-27T09:40:00Z",
  revokedAt: null,
};
const RETIRED: DeviceRecord = {
  id: "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f",
  kind: "handheld",
  name: "Старый ТСД",
  lineId: "9b2e4a6c-0000-4000-8000-000000000000",
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T10:00:00Z",
  lastSeenAt: null,
  revokedAt: "2026-09-26T12:00:00Z",
};

/** A code the host issued `secondsAgo` seconds ago: it lives 10 minutes. */
function pairingCode(secondsAgo: number, hosts = "10.0.0.5,192.168.1.10"): PairingCode {
  return {
    code: "7K3MQ9XV2D",
    expiresAt: new Date(Date.now() + (600 - secondsAgo) * 1000).toISOString(),
    payload: `markiro-host:1?h=${hosts}&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
  };
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listDevices.mockResolvedValue([HOST_PC, RETIRED]);
  return session;
}

async function openDevices(session: FakeOfficeSession, local = openLocalDb().executor) {
  renderOffice(session, { local });
  fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
  await screen.findByText("Рабочее место хоста");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("office devices", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is in the menu for administrators only", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Устройства" })).toBeNull();
    expect(screen.queryByText("Производство")).toBeNull();
  });

  it("lists the devices, naming lines from the local copies", async () => {
    const { db, executor } = openLocalDb();
    db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, 'Линия 1', 0, 3)").run(
      LINE_ID,
    );
    await openDevices(adminSession(), executor);
    expect(screen.getByText("Производство")).toBeTruthy();
    const station = rowOf("Рабочее место хоста");
    expect(within(station).getByText("Станция")).toBeTruthy();
    expect(within(station).getByText("Линия 1")).toBeTruthy();
    expect(within(station).getByText("Действует")).toBeTruthy();
    const retired = rowOf("Старый ТСД");
    expect(within(retired).getByText("ТСД")).toBeTruthy();
    // A line the copies do not know yet shows its short id.
    expect(within(retired).getByText("9b2e4a6c…")).toBeTruthy();
    expect(within(retired).getByText("—")).toBeTruthy();
    expect(within(retired).getByText("Отозвано")).toBeTruthy();
  });

  it("shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(30));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    const matrix = await within(dialog).findByRole("img", { name: "Код подключения для сканера" });
    expect(matrix.querySelector("svg")).not.toBeNull();
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(within(dialog).getByText("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB")).toBeTruthy();
    expect(within(dialog).getByText("10.0.0.5:45710, 192.168.1.10:45710")).toBeTruthy();
    expect(within(dialog).getByText(/^Код действует ещё 09:(30|29)$/)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "После пяти неверных попыток с любого устройства код перестаёт действовать. Если устройство пишет, что код неверен, создайте новый.",
      ),
    ).toBeTruthy();
    expect(session.api.createPairingCode).toHaveBeenCalledWith("office-session-token");
  });

  it("offers a new code once the code expired", async () => {
    const session = adminSession();
    session.api.createPairingCode
      .mockResolvedValueOnce(pairingCode(601))
      .mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText("Срок кода истёк. Создайте новый код.")).toBeTruthy();
    expect(screen.queryByText("7K3MQ 9XV2D")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Новый код" }));
    expect(await screen.findByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(session.api.createPairingCode).toHaveBeenCalledTimes(2);
  });

  it("warns when the host has no address in the local network", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0, ""));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(
      await screen.findByText(
        "У ПК-хоста нет адреса в локальной сети: устройство не найдёт хост по коду. Проверьте сеть ПК-хоста.",
      ),
    ).toBeTruthy();
  });

  it("reads the list every 3 s while the code shows and closes when the device paired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    await screen.findByRole("dialog");
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция на линии 2",
      lineId: null,
      pairedAt: new Date(Date.now() + 1000).toISOString(),
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(await screen.findByText("Устройство «Станция на линии 2» подключено.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("Станция на линии 2")).toBeTruthy();
  });

  it("reads the list again when the dialog is closed", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    const reads = session.api.listDevices.mock.calls.length;
    // The footer button; the × in the title bar is named «Закрыть» too.
    fireEvent.click(within(dialog).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
  });

  it("explains a code the host would not create", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockRejectedValue(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
    );
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
