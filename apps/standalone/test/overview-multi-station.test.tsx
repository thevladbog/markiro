import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceRecord, OfficeLine, OfficeShift } from "../src/host/protocol.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  type FakeOfficeSession,
} from "./support/office.js";
import {
  LINE_10,
  LINE_2,
  MILK,
  participant,
  PARTICIPANT_B,
  SHARED,
  SHARED_NO_REASON,
  STATION_ID,
} from "./support/shifts.js";

const NOW = new Date("2026-10-10T09:00:00.000Z");
const MIN = 60_000;
const agoIso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const THREE: OfficeLine = { ...LINE_2, maxStations: 3 };

/** Line 2 allows three devices; two work its shift, the station not heard for 19 minutes. */
const RUNNING: OfficeShift = {
  ...SHARED,
  id: "11111111-1111-4111-8111-111111111111",
  number: "OCT26-004",
  productId: MILK.id,
  plannedDate: "2026-10-10",
  openedAt: agoIso(8 * 60 * MIN),
  totals: { ...SHARED.totals, lastFactAt: agoIso(2 * MIN) },
  participants: [
    participant({ lastSeenAt: agoIso(19 * MIN) }),
    { ...PARTICIPANT_B, lastSeenAt: agoIso(3 * MIN) },
  ],
};
/** Yesterday's shared shift, closed by its last device without the reason. */
const NO_REASON: OfficeShift = {
  ...SHARED_NO_REASON,
  id: "33333333-3333-4333-8333-333333333333",
  number: "OCT26-003",
  plannedDate: "2026-10-09",
  closedAt: agoIso(20 * 60 * MIN),
};
const STATION: DeviceRecord = {
  id: STATION_ID,
  kind: "station",
  name: "Станция линии 1",
  lineId: THREE.id,
  appVersion: "1.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: agoIso(19 * MIN),
  revokedAt: null,
};

function backupsAt(now: Date) {
  const copy = backupCopy(new Date(now.getTime() - 3 * 60 * MIN).toISOString());
  return {
    ...HEALTHY_BACKUPS,
    now: now.toISOString(),
    local: { ...HEALTHY_BACKUPS.local, copies: [copy] },
    second: { ...HEALTHY_BACKUPS.local, copies: [copy] },
  };
}

function overviewSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listShifts.mockResolvedValue([RUNNING, NO_REASON]);
  // «Указать» leads to the shift's card, which reads the shift.
  session.api.getShift.mockResolvedValue(NO_REASON);
  session.api.listProducts.mockResolvedValue([MILK]);
  session.api.listLines.mockResolvedValue([THREE, LINE_10]);
  session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 0 });
  session.api.listDevices.mockResolvedValue([STATION]);
  session.api.getBackups.mockResolvedValue(backupsAt(NOW));
  session.api.getHostNetwork.mockResolvedValue({
    addresses: [
      { address: "10.0.0.5", mode: "static", mac: "AA-BB-CC-DD-EE-FF", alias: "Ethernet" },
    ],
    port: 45710,
    confirmedAt: null,
  });
  return session;
}

describe("«Обзор» with several devices on a line (plan 2b)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    window.innerWidth = 1440;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.innerWidth = 1024;
  });

  it("says on a line's card how many of its devices are at work, and says nothing on a line of one", async () => {
    renderOffice(overviewSession());
    const lines = await screen.findByRole("region", { name: "Линии" });
    const card = await within(lines).findByRole("article", { name: "Линия 2" });
    expect(within(card).getByText("станций в смене: 2 из 3")).toBeTruthy();
    expect(within(lines).getAllByText(/станций в смене/)).toHaveLength(1);
  });

  it("lists the silent participant once, with its shift and line, in the warn tone, and not again as a silent device", async () => {
    renderOffice(overviewSession());
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    // The lines are a read of their own: until they arrive the plain silent-device row stands in.
    const detail = await within(attention).findByText("Смена OCT26-004, линия «Линия 2»");
    const row = detail.closest("li") as HTMLElement;
    expect(within(row).getByText("Станция линии 1: нет связи 19 мин")).toBeTruthy();
    expect(row.className).toContain("ov-attn__row--warn");
    expect(within(attention).getAllByText(/Станция линии 1: нет связи/)).toHaveLength(1);
  });

  it("asks for the reason of a shift closed without one, and goes to its card", async () => {
    renderOffice(overviewSession());
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    const row = (await within(attention).findByText("Смена OCT26-003 закрыта без причины")).closest(
      "li",
    ) as HTMLElement;
    expect(
      within(row).getByText("Устройства не передали причину расхождения с планом"),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: /Указать/ }));
    expect(await screen.findByRole("heading", { name: "Смены", level: 1 })).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: "Смена OCT26-003" })).toBeTruthy();
  });
});

describe("a shift closed without its reason long ago (spec §12.9: the request stays visible)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    window.innerWidth = 1440;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.innerWidth = 1024;
  });

  /** Made on 1 September, weeks before the Overview's days: the host lists it while the reason is owed. */
  const OLD: OfficeShift = {
    ...NO_REASON,
    productionDate: "2026-09-01",
    plannedDate: "2026-09-01",
    closedAt: "2026-09-01T14:10:00Z",
  };

  it("still asks for the reason, and asks the host for the same days as before", async () => {
    const session = overviewSession();
    session.api.listShifts.mockResolvedValue([OLD]);
    renderOffice(session);
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    expect(await within(attention).findByText("Смена OCT26-003 закрыта без причины")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledWith(expect.any(String), {
      plannedFrom: "2026-10-04",
      plannedTo: "2026-10-11",
    });
  });

  it("leaves it out of the line cards: it is no shift of the Overview's days", async () => {
    const session = overviewSession();
    session.api.listShifts.mockResolvedValue([OLD]);
    renderOffice(session);
    const lines = await screen.findByRole("region", { name: "Линии" });
    await within(lines).findByRole("article", { name: "Линия 2" });
    await screen.findByText("Смена OCT26-003 закрыта без причины");
    expect(within(lines).queryByText(/Последняя: OCT26-003/)).toBeNull();
  });
});

describe("the silent mark follows the Overview's own clock (the host's time, read every 30 seconds)", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.innerWidth = 1024;
  });

  it("turns a participant heard nine minutes ago silent when the next read brings the host's clock past ten", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    window.innerWidth = 1440;
    const session = overviewSession();
    session.api.listShifts.mockResolvedValue([
      {
        ...RUNNING,
        participants: [
          participant({ lastSeenAt: agoIso(9 * MIN) }),
          { ...PARTICIPANT_B, lastSeenAt: agoIso(3 * MIN) },
        ],
      },
    ]);
    session.api.listDevices.mockResolvedValue([{ ...STATION, lastSeenAt: agoIso(MIN) }]);
    renderOffice(session);
    await screen.findByRole("region", { name: "Линии" });
    await screen.findByText("станций в смене: 2 из 3");
    expect(screen.queryByText(/Станция линии 1: нет связи/)).toBeNull();

    // The host's clock moves on by two minutes with the next poll; nothing else changed.
    session.api.getBackups.mockResolvedValue(backupsAt(new Date(NOW.getTime() + 2 * MIN)));
    await vi.advanceTimersByTimeAsync(31_000);
    await waitFor(() => expect(screen.getByText(/Станция линии 1: нет связи 11 мин/)).toBeTruthy());
  });
});
