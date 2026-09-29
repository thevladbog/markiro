import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderLiteralDataMatrixSvg } from "@markiro/domain";
import type * as MarkiroDomain from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { DeviceRecord, OfficeLine, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

// The dialog's countdown re-renders every second (fix round 1, item 3):
// `PairingDataMatrix` must not re-encode the DataMatrix on every tick.
// Wrapping the real implementation in a spy keeps the rendered SVG genuine
// (other tests below check for a real `<svg>`) while one test counts calls.
vi.mock("@markiro/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkiroDomain>();
  return { ...actual, renderLiteralDataMatrixSvg: vi.fn(actual.renderLiteralDataMatrixSvg) };
});

/** How long the codes `pairingCode` builds live, by the host's clock. */
const LIFETIME_MS = 10 * 60 * 1000;
const FINGERPRINT = "ab".repeat(32);
const ARCHIVED_LINE_ID = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const LINES: OfficeLine[] = [
  { id: LINE_ID, name: "Линия 1", archived: false, rev: 3 },
  { id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Линия 10", archived: false, rev: 5 },
  { id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", name: "Линия 2", archived: false, rev: 4 },
  { id: ARCHIVED_LINE_ID, name: "Линия 5", archived: true, rev: 6 },
];
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
const PACKING: DeviceRecord = {
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  kind: "station",
  name: "Станция упаковки",
  lineId: ARCHIVED_LINE_ID,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:30:00Z",
  lastSeenAt: null,
  revokedAt: null,
};
const OFFICE_PC: DeviceRecord = {
  id: "8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b",
  kind: "office",
  name: "Офис бухгалтерии",
  lineId: null,
  appVersion: "0.1.0",
  pairedAt: "2026-09-26T09:45:00Z",
  lastSeenAt: null,
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
    id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
    code: "7K3MQ9XV2D",
    createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    expiresAt: new Date(Date.now() + (600 - secondsAgo) * 1000).toISOString(),
    payload: `markiro-host:1?h=${hosts}&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
  };
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED]);
  session.api.listLines.mockResolvedValue(LINES);
  return session;
}

async function openDevices(session: FakeOfficeSession) {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
  await screen.findByText("Рабочее место хоста");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/** The names column, top to bottom. */
function names(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

/** The labels of a select's options, top to bottom. */
function optionLabels(select: HTMLElement): (string | null)[] {
  return Array.from(select.querySelectorAll("option"), (option) => option.textContent);
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
    // «Производство» stays for the technologist: it holds «Линии».
    expect(screen.getByRole("link", { name: "Линии" })).toBeTruthy();
  });

  it("lists the devices, naming lines from the host's list", async () => {
    await openDevices(adminSession());
    expect(screen.getByText("Производство")).toBeTruthy();
    const station = rowOf("Рабочее место хоста");
    expect(within(station).getByText("Станция")).toBeTruthy();
    expect(within(station).getByText("Линия 1")).toBeTruthy();
    expect(within(station).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Станция упаковки")).getByText("Линия 5 (в архиве)")).toBeTruthy();
    const retired = rowOf("Старый ТСД");
    expect(within(retired).getByText("ТСД")).toBeTruthy();
    // A line the host's list does not know shows its short id.
    expect(within(retired).getByText("9b2e4a6c…")).toBeTruthy();
    expect(within(retired).getByText("—")).toBeTruthy();
    expect(within(retired).getByText("Отозвано")).toBeTruthy();
    // A revoked device is a dead record: nothing to change on it.
    expect(within(retired).queryByRole("button")).toBeNull();
  });

  it("renames a station and moves it to another line, sending only what changed", async () => {
    const session = adminSession();
    const other = LINES[2];
    if (!other) throw new Error("no second line");
    session.api.updateDevice.mockResolvedValue({ ...HOST_PC, name: "Станция 1", lineId: other.id });
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: " Станция 1 " } });
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: other.id } });
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", HOST_PC.id, { name: "Станция 1", lineId: other.id }],
    ]);
    expect(within(rowOf("Станция 1")).getByText("Линия 2")).toBeTruthy();
    // The saved record keeps its row: the table shows the host's order, and an
    // edit does not send the device to the bottom.
    expect(names()).toEqual(["Станция 1", "Станция упаковки", "Офис бухгалтерии", "Старый ТСД"]);
  });

  it("takes a station off its line with null", async () => {
    const session = adminSession();
    session.api.updateDevice.mockResolvedValue({ ...HOST_PC, lineId: null });
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: "" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", HOST_PC.id, { lineId: null }],
    ]);
  });

  it("offers the active lines by name and keeps a station's archived line as it is", async () => {
    const session = adminSession();
    session.api.updateDevice.mockResolvedValue({ ...PACKING, name: "Упаковка" });
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить устройство «Станция упаковки»" }));
    const line = screen.getByLabelText("Линия");
    expect(optionLabels(line)).toEqual([
      "Не выбрана",
      "Линия 1",
      "Линия 2",
      "Линия 10",
      "Линия 5 (в архиве)",
    ]);
    expect(line).toHaveProperty("value", ARCHIVED_LINE_ID);
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Упаковка" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", PACKING.id, { name: "Упаковка" }],
    ]);
  });

  it("has no line to choose for a device that is not a station", async () => {
    const session = adminSession();
    session.api.updateDevice.mockResolvedValue({ ...OFFICE_PC, name: "Офис склада" });
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить устройство «Офис бухгалтерии»" }));
    expect(screen.queryByLabelText("Линия")).toBeNull();
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Офис склада" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateDevice.mock.calls).toStrictEqual([
      ["office-session-token", OFFICE_PC.id, { name: "Офис склада" }],
    ]);
  });

  it("checks the name like the host before sending", async () => {
    const session = adminSession();
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Станция\t1" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(session.api.updateDevice).not.toHaveBeenCalled();
  });

  it("puts a line the host would not take under the line", async () => {
    const session = adminSession();
    session.api.updateDevice.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no such active line",
        details: { field: "lineId" },
      }),
    );
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: LINES[1]?.id ?? "" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    const message = await screen.findByText(
      "Хост не принял эту линию: её могли убрать в архив. Выберите другую.",
    );
    expect(screen.getByLabelText("Линия").getAttribute("aria-describedby")).toBe(message.id);
  });

  it("revokes a device after a confirmation that names it and says it cannot be undone", async () => {
    const session = adminSession();
    const revoked = { ...PACKING, revokedAt: "2026-09-28T10:00:00Z" };
    session.api.revokeDevice.mockResolvedValue(revoked);
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Отозвать устройство «Станция упаковки»" }));
    expect(
      within(dialog()).getByText(
        "Устройство «Станция упаковки» больше не сможет обращаться к хосту, его сессии офиса закроются. Отменить отзыв нельзя: чтобы снова работать на этом устройстве, подключите его заново.",
      ),
    ).toBeTruthy();
    const reads = session.api.listDevices.mock.calls.length;
    // The read that follows the revoke stays pending until the row has been
    // checked: what the revoke itself returned must already show.
    let answerRead: (devices: DeviceRecord[]) => void = () => undefined;
    session.api.listDevices.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerRead = resolve;
        }),
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Устройство «Станция упаковки» отозвано.")).toBeTruthy();
    expect(session.api.revokeDevice.mock.calls).toStrictEqual([
      ["office-session-token", PACKING.id],
    ]);
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
    const dead = rowOf("Станция упаковки");
    expect(within(dead).getByText("Отозвано")).toBeTruthy();
    expect(within(dead).queryByText("Действует")).toBeNull();
    expect(within(dead).queryByRole("button")).toBeNull();
    // The other rows are as they were.
    expect(within(rowOf("Рабочее место хоста")).getByText("Действует")).toBeTruthy();
    await act(async () => {
      answerRead([HOST_PC, revoked, OFFICE_PC, RETIRED]);
    });
    await waitFor(() =>
      expect(within(rowOf("Станция упаковки")).getByText("Отозвано")).toBeTruthy(),
    );
    expect(within(rowOf("Станция упаковки")).queryByRole("button")).toBeNull();
    expect(session.api.listDevices.mock.calls.length).toBe(reads + 1);
  });

  it("marks this PC's row in words and asks more before this PC revokes itself", async () => {
    const session = adminSession();
    session.api.revokeDevice.mockResolvedValue({ ...HOST_PC, revokedAt: "2026-09-28T10:00:00Z" });
    renderOffice(session, { deviceId: HOST_PC.id });
    fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
    await screen.findByText("Рабочее место хоста");
    expect(within(rowOf("Рабочее место хоста")).getByText("Этот ПК")).toBeTruthy();
    expect(screen.getAllByText("Этот ПК")).toHaveLength(1);
    // Another device: the usual confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Отозвать устройство «Станция упаковки»" }));
    expect(within(dialog()).getByText("Отозвать устройство?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    // This PC: the app here disconnects and has to be paired again. Nothing stops it.
    fireEvent.click(
      screen.getByRole("button", { name: "Отозвать устройство «Рабочее место хоста»" }),
    );
    expect(within(dialog()).getByText("Отозвать этот ПК?")).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "«Рабочее место хоста» — этот ПК, на нём открыт офис. После отзыва приложение здесь отключится от хоста, а чтобы снова работать на этом ПК, его нужно подключить заново. Отменить отзыв нельзя.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Устройство «Рабочее место хоста» отозвано.")).toBeTruthy();
    expect(session.api.revokeDevice.mock.calls).toStrictEqual([
      ["office-session-token", HOST_PC.id],
    ]);
  });

  it("explains a revocation the host refused, in the dialog", async () => {
    const session = adminSession();
    session.api.revokeDevice.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such device" }),
    );
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Отозвать устройство «Станция упаковки»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await within(dialog()).findByText("Запись не найдена.")).toBeTruthy();
  });

  it("shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(30));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    const matrix = await within(pairing).findByRole("img", { name: "Код подключения для сканера" });
    expect(matrix.querySelector("svg")).not.toBeNull();
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(within(pairing).getByText("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB")).toBeTruthy();
    expect(within(pairing).getByText("10.0.0.5:45710, 192.168.1.10:45710")).toBeTruthy();
    // A fresh code always starts a full local countdown: its lifetime comes
    // from the host, but it counts from when this PC asked, not from the
    // host's `createdAt`, so `secondsAgo` above (30) does not shift it.
    expect(within(pairing).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    expect(
      within(pairing).getByText(
        "После пяти неверных попыток с любого устройства код перестаёт действовать. Если устройство пишет, что код неверен, создайте новый.",
      ),
    ).toBeTruthy();
    // No code was on screen: the request has no body.
    expect(session.api.createPairingCode.mock.calls).toStrictEqual([["office-session-token"]]);
  });

  it.each([
    ["ahead of", -60 * 60],
    ["behind", 60 * 60],
  ])(
    "shows a fresh 10:00 countdown even when the host clock is an hour %s this PC's",
    async (_direction, secondsAgo) => {
      const session = adminSession();
      session.api.createPairingCode.mockResolvedValue(pairingCode(secondsAgo));
      await openDevices(session);
      fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
      const pairing = await screen.findByRole("dialog");
      expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();
      expect(within(pairing).queryByText("Срок кода истёк. Создайте новый код.")).toBeNull();
      expect(within(pairing).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    },
  );

  it("counts the lifetime the host gives the code, from the moment this PC asked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    // Five minutes by the host's clock, whose times need not match this
    // PC's clock at all: only the duration counts. (Later than every
    // device's `pairedAt`, as a real code is, so no device reads as joined.)
    session.api.createPairingCode.mockResolvedValue({
      ...pairingCode(0),
      createdAt: "2026-09-28T08:00:00Z",
      expiresAt: "2026-09-28T08:05:00Z",
    });
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText(/^Код действует ещё (05:00|04:59)$/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(await screen.findByText("Срок кода истёк. Создайте новый код.")).toBeTruthy();
  });

  it("offers a new code once the code expired, and it replaces the expired one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    // `mockImplementationOnce`, not `mockResolvedValueOnce`: the latter would
    // evaluate both `pairingCode(0)` calls right now, before the 10-minute
    // advance below, so the second code's `expiresAt` would already be stale
    // by the time it is requested. Each call must build its own code fresh,
    // relative to the clock at the moment the host is actually asked.
    session.api.createPairingCode
      .mockImplementationOnce(() => Promise.resolve(pairingCode(0)))
      .mockImplementationOnce(() => Promise.resolve(pairingCode(0)));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    expect(await screen.findByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    // Only this PC's own elapsed time can expire a freshly received code
    // (fix round 1, item 1): wait out the full local countdown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });
    expect(await screen.findByText("Срок кода истёк. Создайте новый код.")).toBeTruthy();
    expect(screen.queryByText("7K3MQ 9XV2D")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Новый код" }));
    expect(await screen.findByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(session.api.createPairingCode.mock.calls).toStrictEqual([
      ["office-session-token"],
      ["office-session-token", { replaces: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d" }],
    ]);
  });

  it("asks for one code when the page's button is double-clicked", async () => {
    const session = adminSession();
    const answers: Array<(code: PairingCode) => void> = [];
    session.api.createPairingCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    await openDevices(session);
    const add = screen.getByRole("button", { name: "Подключить устройство" });
    // Both clicks in one `act`: nothing renders between them, so the button is
    // not yet disabled for the second, and only the page's own guard drops it.
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await waitFor(() => expect(session.api.createPairingCode).toHaveBeenCalledTimes(1));
    // Exactly once: let every pending task settle, then look again.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.createPairingCode).toHaveBeenCalledTimes(1);
    await act(async () => {
      answers[0]?.(pairingCode(0));
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("asks for one new code when the dialog's «Новый код» is double-clicked", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    expect(session.api.createPairingCode).toHaveBeenCalledTimes(1);
    // The request for the new code stays on its way while both clicks land.
    session.api.createPairingCode.mockImplementationOnce(() => new Promise(() => undefined));
    const regenerate = within(pairing).getByRole("button", { name: "Новый код" });
    act(() => {
      fireEvent.click(regenerate);
      fireEvent.click(regenerate);
    });
    await waitFor(() => expect(session.api.createPairingCode).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
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
    session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(await screen.findByText("Устройство «Станция на линии 2» подключено.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("Станция на линии 2")).toBeTruthy();
  });

  it("closes on a join even when this PC's clock is skewed from the host's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Fixed host-clock timestamps, independent of this PC's clock: the host
    // created the code at 09:50 UTC and it lives until 10:00.
    const code: PairingCode = {
      id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
      code: "7K3MQ9XV2D",
      createdAt: "2026-09-27T09:50:00.000Z",
      expiresAt: "2026-09-27T10:00:00.000Z",
      payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
    };
    // This PC's own clock reads an hour ahead of the host's. Join detection
    // must still work: it compares the host's `createdAt` with the host's
    // `pairedAt` and never reads this PC's clock.
    vi.setSystemTime(new Date("2026-09-27T10:50:00.000Z"));
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(code);
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    await screen.findByRole("dialog");
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция при разъехавшихся часах",
      lineId: null,
      pairedAt: "2026-09-27T09:51:00.000Z", // one minute after createdAt, by the host's own clock
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      await screen.findByText("Устройство «Станция при разъехавшихся часах» подключено."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads the list again when the dialog is closed", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    const reads = session.api.listDevices.mock.calls.length;
    // The footer button; the × in the title bar is named «Закрыть» too.
    fireEvent.click(within(pairing).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
  });

  it("does not reopen once closed while a new code was still on its way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    // The "Новый код" request from inside the dialog never resolves until we
    // say so.
    let resolveSecond: (code: PairingCode) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    fireEvent.click(within(pairing).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The abandoned request finally answers: it must not reopen the dialog.
    await act(async () => {
      resolveSecond(pairingCode(0));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the join notice when a device joins while a new code was still on its way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    let resolveSecond: (code: PairingCode) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция во время перевыпуска",
      lineId: null,
      pairedAt: new Date(Date.now() + 1000).toISOString(),
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, PACKING, OFFICE_PC, RETIRED, joined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      await screen.findByText("Устройство «Станция во время перевыпуска» подключено."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The abandoned second code finally answers; it must not reopen the
    // dialog or replace the notice the user already saw.
    await act(async () => {
      resolveSecond(pairingCode(0));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Устройство «Станция во время перевыпуска» подключено.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The join closed the dialog, but its code is kept behind the notice: a
    // code asked for from the page replaces nothing, so the request has no body.
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    await waitFor(() => expect(session.api.createPairingCode).toHaveBeenCalledTimes(3));
    expect(session.api.createPairingCode).toHaveBeenLastCalledWith("office-session-token");
  });

  it("shows no stray failure when a request abandoned by closing the dialog later fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    let rejectSecond: (error: unknown) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    fireEvent.click(within(pairing).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The abandoned request finally fails: it must not show a page-level
    // error for an action nobody is looking at anymore.
    await act(async () => {
      rejectSecond(
        new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Недостаточно прав для этого действия.")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("replaces the old code and restarts the countdown when a new one is requested while one is live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    let pairing = await screen.findByRole("dialog");
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();

    // Two minutes into the first code's countdown: both codes being fresh
    // would make the final assertion below hold either way, so this advance
    // is what makes it actually prove a restart, not just a fresh display.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    expect(within(pairing).queryByText(/^Код действует ещё (10:00|09:59)$/)).toBeNull();

    const secondCode: PairingCode = {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      code: "AAAAABBBBB",
      createdAt: pairingCode(0).createdAt,
      expiresAt: pairingCode(0).expiresAt,
      payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=AAAAABBBBB`,
    };
    session.api.createPairingCode.mockResolvedValueOnce(secondCode);
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    pairing = await screen.findByRole("dialog");
    expect(await within(pairing).findByText("AAAAA BBBBB")).toBeTruthy();
    expect(within(pairing).queryByText("7K3MQ 9XV2D")).toBeNull();
    expect(within(pairing).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    // «Новый код» named the code on screen, so the host ends it at once.
    expect(session.api.createPairingCode.mock.calls).toStrictEqual([
      ["office-session-token"],
      ["office-session-token", { replaces: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d" }],
    ]);
  });

  it("shows a failed regenerate's error inside the dialog and keeps the old code", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();

    session.api.createPairingCode.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
    );
    fireEvent.click(within(pairing).getByRole("button", { name: "Новый код" }));
    expect(await within(pairing).findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    // The old code is still there: a failed regenerate does not blank the dialog.
    expect(within(pairing).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("encodes the DataMatrix once and reuses it while the countdown ticks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const encode = vi.mocked(renderLiteralDataMatrixSvg);
    encode.mockClear();
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValue(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const pairing = await screen.findByRole("dialog");
    // The dialog itself is not enough to wait for: `PairingDataMatrix` loads
    // behind a `Suspense` fallback, so when this test runs alone (nothing
    // has warmed up that lazy chunk yet) the dialog can appear before any
    // encoding has happened. Waiting for the image is not quite enough
    // either -- the first mount while the chunk is loading can still run the
    // memo more than once -- so this records whatever it took to get there
    // and only checks that ticking the countdown afterward adds no more.
    await within(pairing).findByRole("img", { name: "Код подключения для сканера" });
    const shown = encode.mock.calls.length;
    expect(shown).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // five countdown ticks, no re-encode
    });
    expect(encode).toHaveBeenCalledTimes(shown);
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
