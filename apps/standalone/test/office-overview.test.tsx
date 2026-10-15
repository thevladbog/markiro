import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceRecord, HostNetwork } from "../src/host/protocol.js";
import {
  CLOCK_SKEW_MS,
  clockSkewMs,
  deviceSummary,
  ONLINE_WINDOW_MS,
  shiftBuckets,
  shiftProgress,
  storeNearlyFull,
  versionSkew,
} from "../src/office/overview/overview-model.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";
import { licenseOf } from "./support/license.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { ACTIVE, CLOSED, LINE_10, LINE_2, MILK, PLANNED, WATER } from "./support/shifts.js";

const NOW = new Date("2026-10-10T09:00:00.000Z");

function device(overrides: Partial<DeviceRecord>): DeviceRecord {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    kind: "station",
    name: "Станция",
    lineId: null,
    appVersion: "2.1.0",
    pairedAt: "2026-09-26T09:15:00Z",
    lastSeenAt: NOW.toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe("the overview's reading of the host's lists", () => {
  it("sorts shifts into those at work, those planned for the site's today, and those closed today", () => {
    const buckets = shiftBuckets(
      [PLANNED, ACTIVE, { ...CLOSED, plannedDate: "2026-10-10" }],
      "2026-10-10",
    );
    expect(buckets.active.map((shift) => shift.number)).toEqual([ACTIVE.number]);
    expect(buckets.plannedToday.map((shift) => shift.number)).toEqual([PLANNED.number]);
    expect(buckets.closedToday).toBe(1);
    expect(shiftBuckets([PLANNED], "2026-10-11").plannedToday).toEqual([]);
  });

  it("measures the output against the plan, at most 100 %, and says nothing of a shift without a plan", () => {
    expect(shiftProgress(ACTIVE)).toEqual({ done: 540, planned: 1200, percent: 45 });
    expect(
      shiftProgress({ ...ACTIVE, totals: { ...ACTIVE.totals, unitsInClosedBoxes: 3000 } }).percent,
    ).toBe(100);
    expect(shiftProgress({ ...ACTIVE, plannedQty: null }).percent).toBeNull();
  });

  it("counts the devices on line by kind, leaving out the revoked, and lists the silent longest first", () => {
    const summary = deviceSummary(
      [
        device({ id: "a", name: "Свежая" }),
        device({ id: "b", name: "Давно", lastSeenAt: "2026-10-09T09:00:00Z" }),
        device({ id: "c", name: "Никогда", lastSeenAt: null }),
        device({ id: "d", kind: "handheld", lastSeenAt: "2026-10-10T08:55:00Z" }),
        device({ id: "e", revokedAt: "2026-10-01T00:00:00Z", lastSeenAt: null }),
      ],
      NOW.getTime(),
    );
    expect(summary.byKind.station).toEqual({ online: 1, total: 3 });
    expect(summary.byKind.handheld).toEqual({ online: 1, total: 1 });
    expect(summary.byKind.office).toEqual({ online: 0, total: 0 });
    expect(summary.silent.map((each) => each.name)).toEqual(["Никогда", "Давно"]);
  });

  it("takes a device last heard just inside the window as on line, and just outside as silent", () => {
    const inside = new Date(NOW.getTime() - ONLINE_WINDOW_MS).toISOString();
    const outside = new Date(NOW.getTime() - ONLINE_WINDOW_MS - 1000).toISOString();
    expect(
      deviceSummary([device({ lastSeenAt: inside })], NOW.getTime()).byKind.station.online,
    ).toBe(1);
    expect(
      deviceSummary([device({ lastSeenAt: outside })], NOW.getTime()).byKind.station.online,
    ).toBe(0);
  });

  it("finds the devices on another version than the host, and none when the host's is unknown", () => {
    const devices = [device({ id: "a" }), device({ id: "b", appVersion: "2.0.0" })];
    expect(versionSkew(devices, "2.1.0").map((each) => each.id)).toEqual(["b"]);
    expect(versionSkew(devices, null)).toEqual([]);
  });

  it("reads the clocks' difference and a nearly full store", () => {
    expect(clockSkewMs("2026-10-10T09:00:00Z", NOW.getTime())).toBe(0);
    expect(Math.abs(clockSkewMs("2026-10-10T08:50:00Z", NOW.getTime()))).toBeGreaterThan(
      CLOCK_SKEW_MS,
    );
    const settings = {
      retentionDays: null,
      fileCount: 1,
      storedBytes: 80,
      originalBytes: 90,
      maxStoredBytes: 100,
    };
    expect(storeNearlyFull(settings)).toBe(true);
    expect(storeNearlyFull({ ...settings, storedBytes: 79 })).toBe(false);
  });
});

const STATIC_NETWORK: HostNetwork = {
  addresses: [{ address: "10.0.0.5", mode: "static", mac: "AA-BB-CC-DD-EE-FF", alias: "Ethernet" }],
  port: 45710,
  confirmedAt: null,
};

function overviewSession(user?: typeof TECHNOLOGIST): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listShifts.mockResolvedValue([ACTIVE, PLANNED, CLOSED]);
  session.api.listProducts.mockResolvedValue([MILK, WATER]);
  session.api.listLines.mockResolvedValue([LINE_2, LINE_10]);
  session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 3 });
  session.api.listDevices.mockResolvedValue([
    device({ id: "a", name: "Станция упаковки" }),
    device({ id: "b", name: "Станция склада", lastSeenAt: "2026-10-09T08:00:00Z" }),
  ]);
  session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, now: NOW.toISOString() });
  session.api.getHostNetwork.mockResolvedValue(STATIC_NETWORK);
  return session;
}

describe("«Обзор» of the office (beta 3.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the shifts at work with their progress, and links each to its drawer", async () => {
    renderOffice(overviewSession());
    const card = (await screen.findByRole("heading", { name: "Смены в работе" })).closest(
      ".mk-card",
    );
    expect(card).not.toBeNull();
    const link = await within(card as HTMLElement).findByRole("link", { name: ACTIVE.number });
    expect(link.getAttribute("href")).toBe(`/shifts?shift=${ACTIVE.id}`);
    expect(within(card as HTMLElement).getByText(/Молоко 3,2% 0,9 л · Линия 2/)).toBeTruthy();
    expect(within(card as HTMLElement).getByText("540 из 1 200 (45 %)")).toBeTruthy();
    const bar = within(card as HTMLElement).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
  });

  it("shows the shifts planned for the site's today", async () => {
    renderOffice(overviewSession());
    const card = (await screen.findByRole("heading", { name: "Запланировано на сегодня" })).closest(
      ".mk-card",
    );
    const link = await within(card as HTMLElement).findByRole("link", { name: PLANNED.number });
    expect(link.getAttribute("href")).toBe(`/shifts?shift=${PLANNED.id}`);
  });

  it("counts the conflicts waiting for a review and links to them", async () => {
    renderOffice(overviewSession());
    const card = (await screen.findByRole("heading", { name: "Конфликты" })).closest(".mk-card");
    expect(await within(card as HTMLElement).findByText("Ждут разбора: 3.")).toBeTruthy();
    expect(
      within(card as HTMLElement)
        .getByRole("link", { name: "Открыть «Конфликты»" })
        .getAttribute("href"),
    ).toBe("/conflicts");
  });

  it("counts the devices on line by kind and names the silent ones, for an administrator", async () => {
    renderOffice(overviewSession());
    const card = (await screen.findByRole("heading", { name: "Устройства" })).closest(".mk-card");
    expect(await within(card as HTMLElement).findByText("на связи 1 из 2")).toBeTruthy();
    expect(
      within(card as HTMLElement).getByText(/Станция склада — на связи в последний раз/),
    ).toBeTruthy();
  });

  it("leaves the devices out for a technologist, who cannot read them", async () => {
    const session = overviewSession(TECHNOLOGIST);
    renderOffice(session);
    await screen.findByRole("heading", { name: "Смены в работе" });
    expect(screen.queryByRole("heading", { name: "Устройства" })).toBeNull();
    expect(session.api.listDevices).not.toHaveBeenCalled();
  });

  it("says when the last copy was made and hints at the second folder when there is none", async () => {
    const session = overviewSession();
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      now: NOW.toISOString(),
      second: null,
    });
    renderOffice(session);
    const card = (await screen.findByRole("heading", { name: "Резервные копии" })).closest(
      ".mk-card",
    );
    expect(await within(card as HTMLElement).findByText(/Последняя копия: /)).toBeTruthy();
    expect(within(card as HTMLElement).getByText(/Вторая папка не задана/)).toBeTruthy();
  });

  it("shows the state the host computed on the license card, with the way to «Информация» (plan ЛЦ-3)", async () => {
    renderOffice(overviewSession());
    const card = (await screen.findByRole("heading", { name: "Лицензия" })).closest(".mk-card");
    expect(await within(card as HTMLElement).findByText("Действует")).toBeTruthy();
    expect(
      within(card as HTMLElement)
        .getByRole("link", { name: "Открыть «Информация»" })
        .getAttribute("href"),
    ).toBe("/about#license");
  });

  it("says on the card that no new shift opens when the host restricts the license", async () => {
    const session = overviewSession();
    session.api.getLicense.mockResolvedValue(
      licenseOf({ state: "restricted", opensNewShifts: false }),
    );
    renderOffice(session);
    const card = (await screen.findByRole("heading", { name: "Лицензия" })).closest(".mk-card");
    expect(
      await within(card as HTMLElement).findByText("Ограничена: новые смены не открываются"),
    ).toBeTruthy();
  });

  it("offers the quick actions its role may use", async () => {
    renderOffice(overviewSession());
    expect(await screen.findByRole("button", { name: "Запланировать смену" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подключить устройство" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Поиск кодов" })).toBeTruthy();
  });

  it("does not offer «Подключить устройство» to a technologist", async () => {
    renderOffice(overviewSession(TECHNOLOGIST));
    await screen.findByRole("button", { name: "Запланировать смену" });
    expect(screen.queryByRole("button", { name: "Подключить устройство" })).toBeNull();
  });

  it("warns of a host clock far from this PC's, and of devices on another version", async () => {
    const session = overviewSession();
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      now: "2026-10-10T08:30:00.000Z",
    });
    session.api.listDevices.mockResolvedValue([device({ appVersion: "0.0.1" })]);
    renderOffice(session, {});
    expect(
      await screen.findByText(/Часы этого компьютера и хоста расходятся на 30 мин/),
    ).toBeTruthy();
  });

  it("says a list that did not load in its own card and keeps the others", async () => {
    const session = overviewSession();
    session.api.listConflicts.mockRejectedValue(new Error("down"));
    renderOffice(session);
    const card = (await screen.findByRole("heading", { name: "Конфликты" })).closest(".mk-card");
    expect(
      await within(card as HTMLElement).findByRole("button", { name: "Повторить" }),
    ).toBeTruthy();
    expect(await screen.findByRole("link", { name: ACTIVE.number })).toBeTruthy();
  });

  it("warns that the host's address may change while one is by DHCP, and confirms the reservation", async () => {
    const session = overviewSession();
    session.api.getHostNetwork.mockResolvedValue({
      addresses: [
        {
          address: "192.168.1.10",
          mode: "dhcp",
          mac: "AA-BB-CC-DD-EE-FF",
          alias: "Беспроводная сеть",
        },
      ],
      port: 45710,
      confirmedAt: null,
    });
    session.api.confirmHostNetwork.mockResolvedValue({
      addresses: [
        {
          address: "192.168.1.10",
          mode: "dhcp",
          mac: "AA-BB-CC-DD-EE-FF",
          alias: "Беспроводная сеть",
        },
      ],
      port: 45710,
      confirmedAt: "2026-10-10T09:00:00Z",
    });
    renderOffice(session);
    const notice = await screen.findByRole("alert", { name: /Адрес хоста может измениться/ });
    expect(within(notice).getByText(/192\.168\.1\.10/)).toBeTruthy();
    expect(within(notice).getByText(/AA-BB-CC-DD-EE-FF/)).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "Я зарезервировал адрес" }));
    await waitFor(() =>
      expect(session.api.confirmHostNetwork).toHaveBeenCalledWith("office-session-token", {
        confirmed: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert", { name: /Адрес хоста может измениться/ })).toBeNull(),
    );
  });

  it("says nothing about the address when it is static, or confirmed, or the reader is no administrator", async () => {
    const confirmed = overviewSession();
    confirmed.api.getHostNetwork.mockResolvedValue({
      addresses: [{ address: "192.168.1.10", mode: "dhcp", mac: null, alias: null }],
      port: 45710,
      confirmedAt: "2026-10-10T08:00:00Z",
    });
    renderOffice(confirmed);
    await screen.findByRole("heading", { name: "Смены в работе" });
    expect(screen.queryByRole("alert", { name: /Адрес хоста может измениться/ })).toBeNull();
    cleanup();
    const technologist = overviewSession(TECHNOLOGIST);
    renderOffice(technologist);
    await screen.findByRole("heading", { name: "Смены в работе" });
    expect(technologist.api.getHostNetwork).not.toHaveBeenCalled();
  });
});
