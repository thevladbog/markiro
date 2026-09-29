import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderLiteralDataMatrixSvg } from "@markiro/domain";
import type * as MarkiroDomain from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import { CODE_LIFETIME_MS } from "../src/office/devices/PairingCodeDialog.js";
import type { DeviceRecord, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
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
    id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
    code: "7K3MQ9XV2D",
    createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
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
    // A fresh code always starts a full local countdown (fix round 1, item 1):
    // anchored to when this PC received it, not to the host's `expiresAt`, so
    // `secondsAgo` above (30) does not shift it.
    expect(within(dialog).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "После пяти неверных попыток с любого устройства код перестаёт действовать. Если устройство пишет, что код неверен, создайте новый.",
      ),
    ).toBeTruthy();
    expect(session.api.createPairingCode).toHaveBeenCalledWith("office-session-token");
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
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();
      expect(within(dialog).queryByText("Срок кода истёк. Создайте новый код.")).toBeNull();
      expect(within(dialog).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    },
  );

  it("offers a new code once the code expired", async () => {
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
      await vi.advanceTimersByTimeAsync(CODE_LIFETIME_MS);
    });
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

  it("closes on a join even when this PC's clock is skewed from the host's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Fixed host-clock timestamps, independent of this PC's clock: the host
    // issued the code at 09:50 UTC (issuedAt = expiresAt - 10 min) and it
    // lives until 10:00.
    const code: PairingCode = {
      id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
      code: "7K3MQ9XV2D",
      createdAt: "2026-09-27T09:50:00.000Z",
      expiresAt: "2026-09-27T10:00:00.000Z",
      payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
    };
    // This PC's own clock reads an hour ahead of the host's. Join detection
    // must still work: it never reads this PC's clock (fix round 1, item 1
    // fixed the countdown only; join detection already compared host-clock
    // values, and this proves it stays that way).
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
      pairedAt: "2026-09-27T09:51:00.000Z", // one minute after issuedAt, by the host's own clock
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, RETIRED, joined]);
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
    const dialog = await screen.findByRole("dialog");
    const reads = session.api.listDevices.mock.calls.length;
    // The footer button; the × in the title bar is named «Закрыть» too.
    fireEvent.click(within(dialog).getByText("Закрыть"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listDevices.mock.calls.length).toBe(reads + 1));
  });

  it("does not reopen once closed while a new code was still on its way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    // The "Новый код" request from inside the dialog never resolves until we
    // say so.
    let resolveSecond: (code: PairingCode) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    fireEvent.click(within(dialog).getByText("Закрыть"));
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
    const dialog = await screen.findByRole("dialog");
    let resolveSecond: (code: PairingCode) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    const joined: DeviceRecord = {
      ...HOST_PC,
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      name: "Станция во время перевыпуска",
      lineId: null,
      pairedAt: new Date(Date.now() + 1000).toISOString(),
      lastSeenAt: null,
    };
    session.api.listDevices.mockResolvedValue([HOST_PC, RETIRED, joined]);
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
  });

  it("shows no stray failure when a request abandoned by closing the dialog later fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    let rejectSecond: (error: unknown) => void = () => undefined;
    session.api.createPairingCode.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    fireEvent.click(within(dialog).getByText("Закрыть"));
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
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();

    // Two minutes into the first code's countdown: both codes being fresh
    // would make the final assertion below hold either way, so this advance
    // is what makes it actually prove a restart, not just a fresh display.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    expect(within(dialog).queryByText(/^Код действует ещё (10:00|09:59)$/)).toBeNull();

    const secondCode: PairingCode = {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      code: "AAAAABBBBB",
      createdAt: pairingCode(0).createdAt,
      expiresAt: pairingCode(0).expiresAt,
      payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=AAAAABBBBB`,
    };
    session.api.createPairingCode.mockResolvedValueOnce(secondCode);
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("AAAAA BBBBB")).toBeTruthy();
    expect(within(dialog).queryByText("7K3MQ 9XV2D")).toBeNull();
    expect(within(dialog).getByText(/^Код действует ещё (10:00|09:59)$/)).toBeTruthy();
    expect(session.api.createPairingCode).toHaveBeenCalledTimes(2);
  });

  it("shows a failed regenerate's error inside the dialog and keeps the old code", async () => {
    const session = adminSession();
    session.api.createPairingCode.mockResolvedValueOnce(pairingCode(0));
    await openDevices(session);
    fireEvent.click(screen.getByRole("button", { name: "Подключить устройство" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();

    session.api.createPairingCode.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "admins only" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    expect(await within(dialog).findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    // The old code is still there: a failed regenerate does not blank the dialog.
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();
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
    const dialog = await screen.findByRole("dialog");
    // The dialog itself is not enough to wait for: `PairingDataMatrix` loads
    // behind a `Suspense` fallback, so when this test runs alone (nothing
    // has warmed up that lazy chunk yet) the dialog can appear before any
    // encoding has happened. Waiting for the image is not quite enough
    // either -- the first mount while the chunk is loading can still run the
    // memo more than once -- so this records whatever it took to get there
    // and only checks that ticking the countdown afterward adds no more.
    await within(dialog).findByRole("img", { name: "Код подключения для сканера" });
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
