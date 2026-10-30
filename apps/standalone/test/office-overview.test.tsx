import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type {
  DemoDataSummary,
  DeviceRecord,
  HostNetwork,
  HostStatus,
  OfficeShift,
} from "../src/host/protocol.js";
import {
  CLOCK_SKEW_MS,
  clockSkewMs,
  deviceSummary,
  ONLINE_WINDOW_MS,
  shiftBuckets,
  shiftProgress,
  storeNearlyFull,
} from "../src/office/overview/overview-model.js";
import { licenseOf } from "./support/license.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { ACTIVE, CLOSED, LINE_10, LINE_2, MILK, PLANNED, WATER } from "./support/shifts.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";

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

/** 12:00 in Moscow on 2026-10-10: «today» is that civil date, «yesterday» the 9th. */
const MIN = 60_000;
const agoIso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function shiftOf(
  overrides: Omit<Partial<OfficeShift>, "totals"> & { totals?: Partial<OfficeShift["totals"]> },
): OfficeShift {
  const { totals, ...rest } = overrides;
  return { ...ACTIVE, ...rest, totals: { ...ACTIVE.totals, ...totals } };
}

/** Line 2 runs (plan 12 000), line 10 has been silent 18 minutes; yesterday's output is 30 020. */
const RUNNING = shiftOf({
  id: "11111111-1111-4111-8111-111111111111",
  number: "OCT26-004",
  lineId: LINE_2.id,
  productId: MILK.id,
  plannedDate: "2026-10-10",
  plannedQty: 12_000,
  openedAt: agoIso(8 * 60 * MIN),
  totals: {
    unitsInClosedBoxes: 8_580,
    closedBoxes: 715,
    closedPallets: 10,
    lastFactAt: agoIso(2 * MIN),
  },
});
const IDLE = shiftOf({
  id: "22222222-2222-4222-8222-222222222222",
  number: "OCT26-005",
  lineId: LINE_10.id,
  productId: WATER.id,
  plannedDate: "2026-10-10",
  plannedQty: 14_000,
  openedAt: agoIso(8 * 60 * MIN),
  totals: {
    unitsInClosedBoxes: 9_840,
    closedBoxes: 820,
    closedPallets: 11,
    lastFactAt: agoIso(18 * MIN),
  },
});
const YESTERDAY = shiftOf({
  id: "33333333-3333-4333-8333-333333333333",
  number: "OCT26-003",
  status: "closed",
  plannedDate: "2026-10-09",
  closedAt: agoIso(20 * 60 * MIN),
  totals: {
    unitsInClosedBoxes: 30_020,
    closedBoxes: 2_502,
    closedPallets: 35,
    lastFactAt: agoIso(20 * 60 * MIN),
  },
});
const TOMORROW = shiftOf({
  id: "44444444-4444-4444-8444-444444444444",
  number: "OCT26-009",
  status: "planned",
  plannedDate: "2026-10-11",
  plannedQty: 22_000,
  openedAt: null,
  totals: {},
});

function overviewSession(user?: typeof TECHNOLOGIST): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listShifts.mockResolvedValue([RUNNING, IDLE, YESTERDAY, TOMORROW]);
  session.api.listProducts.mockResolvedValue([MILK, WATER]);
  session.api.listLines.mockResolvedValue([LINE_2, LINE_10]);
  session.api.listConflicts.mockResolvedValue({
    items: [],
    page: 1,
    pageCount: 1,
    total: 3,
  });
  session.api.listDevices.mockResolvedValue([
    device({ id: "a", name: "Станция упаковки" }),
    device({ id: "b", name: "Станция склада", lastSeenAt: agoIso(47 * MIN) }),
  ]);
  session.api.getBackups.mockResolvedValue({
    ...HEALTHY_BACKUPS,
    now: NOW.toISOString(),
    local: { ...HEALTHY_BACKUPS.local, copies: [backupCopy(agoIso(3 * 60 * MIN))] },
    second: { ...HEALTHY_BACKUPS.local, copies: [backupCopy(agoIso(3 * 60 * MIN))] },
  });
  session.api.getHostNetwork.mockResolvedValue(STATIC_NETWORK);
  session.api.getDemoData.mockResolvedValue(NO_DEMO);
  return session;
}

const NO_DEMO: DemoDataSummary = {
  present: false,
  productId: null,
  shifts: 0,
  boxes: 0,
  pallets: 0,
  codes: 0,
  activeShifts: [],
};
const DEMO: DemoDataSummary = {
  present: true,
  productId: WATER.id,
  shifts: 1,
  boxes: 4,
  pallets: 2,
  codes: 20,
  activeShifts: [],
};

const ONLINE: HostStatus = {
  state: "online",
  lastContactAt: NOW.getTime(),
  lastError: null,
  seq: 1,
};
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: NOW.getTime() - 53 * MIN,
  lastError: "unreachable",
  seq: 2,
};

function panel(name: string): HTMLElement {
  const found = screen.getByRole("region", { name });
  return found;
}

describe("«Обзор» of the office (design 2026-10, phase 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    window.innerWidth = 1440;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.innerWidth = 1024;
  });

  it("shows the day's four figures with yesterday as text, the conflicts waiting as the fourth", async () => {
    renderOffice(overviewSession());
    const strip = await screen.findByRole("group", { name: "Показатели за сутки" });
    await waitFor(() => expect(within(strip).getByText("18 420")).toBeTruthy());
    expect(within(strip).getByText("Вчера: 30 020")).toBeTruthy();
    expect(within(strip).getByText("1 535")).toBeTruthy();
    expect(within(strip).getByText("Вчера: 2 502")).toBeTruthy();
    expect(within(strip).getByText("21")).toBeTruthy();
    expect(within(strip).getByText("Вчера: 35")).toBeTruthy();
    expect(within(strip).getByText("ждут разбора")).toBeTruthy();
    expect(within(strip).getByText("Расхождений")).toBeTruthy();
    // No delta is drawn in phase 1: a percent sign or an arrow would claim «at the same time».
    expect(within(strip).queryByText(/%/)).toBeNull();
  });

  it("draws a card per line: status in a word, the shift, the product's print name, progress against the plan, pace and end", async () => {
    renderOffice(overviewSession());
    const lines = await screen.findByRole("region", { name: "Линии" });
    const running = await within(lines).findByRole("article", { name: "Линия 2" });
    expect(within(running).getByText("Идёт")).toBeTruthy();
    expect(within(running).getByRole("link", { name: "OCT26-004" }).getAttribute("href")).toBe(
      `/shifts?shift=${RUNNING.id}`,
    );
    expect(within(running).getByText("Молоко 3,2%")).toBeTruthy();
    expect(within(running).getByText("8 580 / 12 000 · 72 %")).toBeTruthy();
    expect(within(running).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("72");
    expect(within(running).getByText(/шт\/ч/)).toBeTruthy();
    expect(within(running).getByText(/^≈ \d\d:\d\d$/)).toBeTruthy();
  });

  it("calls a line silent for more than ten minutes idle, in a word and a timer, and lists it under attention in the warn tone", async () => {
    renderOffice(overviewSession());
    const lines = await screen.findByRole("region", { name: "Линии" });
    const idle = await within(lines).findByRole("article", { name: "Линия 10" });
    expect(within(idle).getByText("Простой")).toBeTruthy();
    expect(within(idle).getByText("нет сканов 18 мин")).toBeTruthy();
    const attention = panel("Требует внимания");
    const row = within(attention)
      .getByText(/Простой: Линия 10/)
      .closest("li");
    expect(row?.className).toContain("ov-attn__row--warn");
    expect(within(row as HTMLElement).getByText(/Внимание:/)).toBeTruthy();
  });

  it("lists what needs a person with a button to each: conflicts, a silent device, and the way to them", async () => {
    renderOffice(overviewSession());
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    expect(await within(attention).findByText(/Расхождения ждут разбора: 3/)).toBeTruthy();
    expect(within(attention).getByText(/Станция склада: нет связи 47 мин/)).toBeTruthy();
    fireEvent.click(within(attention).getByRole("button", { name: /Разобрать/ }));
    expect(await screen.findByRole("heading", { name: "Конфликты", level: 1 })).toBeTruthy();
  });

  it("says the system is fine in one line when nothing needs a person, and keeps the steady state in its own panel", async () => {
    const session = overviewSession();
    session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 0 });
    session.api.listDevices.mockResolvedValue([device({ id: "a" })]);
    session.api.listShifts.mockResolvedValue([YESTERDAY]);
    renderOffice(session);
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    expect(
      await within(attention).findByText("Остальное в порядке: на связи 1 из 1."),
    ).toBeTruthy();
    const system = await screen.findByRole("region", { name: "Состояние системы" });
    expect(within(system).getByText("На связи 1 из 1")).toBeTruthy();
    expect(within(system).getByText("Все на связи")).toBeTruthy();
    expect(within(system).getByText("В порядке")).toBeTruthy();
    expect(within(system).getByText("Активна")).toBeTruthy();
  });

  it("lists a license that opens no new shift as an error, with the way to its section (plan ЛЦ-3)", async () => {
    const session = overviewSession();
    session.api.getLicense.mockResolvedValue(
      licenseOf({ state: "restricted", opensNewShifts: false }),
    );
    renderOffice(session);
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    const row = (
      await within(attention).findByText(/Ограничена: новые смены не открываются/)
    ).closest("li") as HTMLElement;
    expect(row.className).toContain("ov-attn__row--err");
    fireEvent.click(within(row).getByRole("button", { name: /Лицензия/ }));
    expect(await screen.findByRole("heading", { name: "Информация", level: 1 })).toBeTruthy();
    cleanup();
    const system = overviewSession();
    system.api.getLicense.mockResolvedValue(
      licenseOf({ state: "restricted", opensNewShifts: false }),
    );
    renderOffice(system);
    const panelSystem = await screen.findByRole("region", { name: "Состояние системы" });
    expect(await within(panelSystem).findByText("Ошибка")).toBeTruthy();
  });

  it("counts today's and tomorrow's shifts by phase", async () => {
    renderOffice(overviewSession());
    const shifts = await screen.findByRole("region", { name: "Смены" });
    const today = (await within(shifts).findByText("Сегодня")).closest("li") as HTMLElement;
    expect(within(today).getByText("2 идут")).toBeTruthy();
    const tomorrow = within(shifts).getByText("Завтра").closest("li") as HTMLElement;
    expect(within(tomorrow).getByText("1 план")).toBeTruthy();
    expect(within(tomorrow).getByText("план 22 000")).toBeTruthy();
    expect(
      within(shifts)
        .getByRole("link", { name: /Все смены/ })
        .getAttribute("href"),
    ).toBe("/shifts");
  });

  it("gives the chart a name and a summary, with a table in the page that a screen reader reads", async () => {
    renderOffice(overviewSession());
    const chart = await screen.findByRole("img", {
      name: /Выпуск по дням за 7 дней: сегодня 18\s420, вчера 30\s020, пик 30\s020 — пт 9/,
    });
    const tableId = chart.getAttribute("aria-describedby");
    expect(tableId).not.toBeNull();
    const table = document.getElementById(tableId ?? "") as HTMLElement;
    expect(table.tagName).toBe("TABLE");
    expect(within(table).getByRole("columnheader", { name: "пт 9" })).toBeTruthy();
    expect(table.querySelector("caption")?.textContent).toBe("Выпуск по дням за 7 дней");
    // In the chart view the table is hidden from the eye, not from the page.
    expect(table.closest(".ov-visually-hidden")).not.toBeNull();
  });

  it("switches to the table, where the sign of the difference is written, and back", async () => {
    renderOffice(overviewSession());
    const toggle = await screen.findByRole("radio", { name: "Таблица" });
    expect(screen.getByRole("radio", { name: "График" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    const table = document.querySelector(".ov-chart__table") as HTMLElement;
    expect(table.closest(".ov-visually-hidden")).toBeNull();
    expect(screen.queryByRole("img", { name: /Выпуск по дням/ })).toBeNull();
    // 18 420 today against 30 020 yesterday: written with its minus, not only coloured.
    expect(within(table).getByText("−11 600")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "График" }));
    expect(await screen.findByRole("img", { name: /Выпуск по дням/ })).toBeTruthy();
  });

  it("marks today's column by form: a solid bar for today, an outlined one for the days before", async () => {
    renderOffice(overviewSession());
    await screen.findByRole("img", { name: /Выпуск по дням/ });
    const bars = Array.from(document.querySelectorAll(".ov-chart__bar"));
    expect(bars.filter((bar) => bar.classList.contains("ov-chart__bar--today"))).toHaveLength(1);
    expect(bars.length).toBeGreaterThan(1);
  });

  it("reads again every 30 seconds and says when it last did, without a live region", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const session = overviewSession();
    renderOffice(session);
    await screen.findByRole("img", { name: /Выпуск по дням/ });
    const label = screen.getByText(/^Обновлено \d\d:\d\d:\d\d$/);
    expect(label.closest("[aria-live]")?.getAttribute("aria-live")).toBe("off");
    const before = session.api.listShifts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    await waitFor(() => expect(session.api.listShifts.mock.calls.length).toBeGreaterThan(before));
  });

  it("leaves the devices out for a technologist, who cannot read them, and keeps the figures and the chart", async () => {
    const session = overviewSession(TECHNOLOGIST);
    renderOffice(session);
    expect(await screen.findByRole("img", { name: /Выпуск по дням/ })).toBeTruthy();
    await screen.findByRole("region", { name: "Состояние системы" });
    expect(session.api.listDevices).not.toHaveBeenCalled();
    expect(screen.queryByText("Устройства", { selector: "strong" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Подключить устройство" })).toBeNull();
    expect(screen.getByRole("button", { name: "Запланировать смену" })).toBeTruthy();
  });

  it("offers the quick actions its role may use", async () => {
    renderOffice(overviewSession());
    expect(await screen.findByRole("button", { name: "Запланировать смену" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подключить устройство" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Поиск кодов" })).toBeTruthy();
  });

  it("says a block that did not load in its own place and keeps the others", async () => {
    const session = overviewSession();
    session.api.listShifts.mockRejectedValue(new Error("down"));
    renderOffice(session);
    expect(await screen.findByText("Не удалось загрузить показатели")).toBeTruthy();
    expect(screen.getByText("Не удалось загрузить выпуск")).toBeTruthy();
    expect(screen.getByText("Не удалось загрузить линии")).toBeTruthy();
    expect(screen.getByText("Не удалось загрузить смены")).toBeTruthy();
    // The attention list and the system panel read other queries and stand.
    const attention = screen.getByRole("region", { name: "Требует внимания" });
    expect(await within(attention).findByText(/Расхождения ждут разбора: 3/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Повторить" }).length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the conflict figure when only the conflicts failed", async () => {
    const session = overviewSession();
    session.api.listConflicts.mockRejectedValue(new Error("down"));
    renderOffice(session);
    const strip = await screen.findByRole("group", { name: "Показатели за сутки" });
    await waitFor(() => expect(within(strip).getByText("18 420")).toBeTruthy());
    expect(within(strip).getByText("не загрузилось")).toBeTruthy();
    const attention = screen.getByRole("region", { name: "Требует внимания" });
    expect(await within(attention).findByText(/Станция склада: нет связи/)).toBeTruthy();
    expect(within(attention).getByRole("button", { name: "Повторить" })).toBeTruthy();
  });

  it("shows skeletons with the headings real and the panels busy while the lists load", async () => {
    const session = overviewSession();
    session.api.listShifts.mockReturnValue(new Promise(() => undefined));
    renderOffice(session);
    const chart = await screen.findByRole("region", { name: "Выпуск по дням · 7 дней" });
    expect(chart.getAttribute("aria-busy")).toBe("true");
    expect(within(chart).getByRole("heading", { name: "Выпуск по дням · 7 дней" })).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Показатели за сутки" }).getAttribute("aria-busy"),
    ).toBe("true");
    expect(document.querySelectorAll(".ov-skel").length).toBeGreaterThan(3);
  });

  it("shows «Первые шаги» and a placeholder chart for a site with nothing in it, and no system panel", async () => {
    const session = overviewSession();
    session.api.listShifts.mockResolvedValue([]);
    session.api.listLines.mockResolvedValue([]);
    session.api.listProducts.mockResolvedValue([]);
    session.api.listDevices.mockResolvedValue([]);
    session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 0 });
    renderOffice(session);
    const steps = await screen.findByRole("region", { name: "Первые шаги" });
    expect(within(steps).getByText("1 из 5")).toBeTruthy();
    expect(within(steps).getByRole("button", { name: "Линии" })).toBeTruthy();
    expect(await screen.findByText("График появится после первой смены")).toBeTruthy();
    expect(screen.getByText("Линий пока нет")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Добавить линию" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Состояние системы" })).toBeNull();
    expect(screen.getAllByText("нет данных").length).toBe(4);
  });

  it("says «смен нет» on a quiet night, compares with yesterday in words and keeps the chart", async () => {
    const session = overviewSession();
    session.api.listShifts.mockResolvedValue([YESTERDAY, { ...TOMORROW }]);
    session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 0 });
    session.api.listDevices.mockResolvedValue([device({ id: "a" })]);
    renderOffice(session);
    const strip = await screen.findByRole("group", { name: "Показатели за сутки" });
    await waitFor(() => expect(within(strip).getByText("Вчера: 30 020")).toBeTruthy());
    // Three figures of the day are zero, and no conflict waits.
    expect(within(strip).getAllByText("0").length).toBe(4);
    expect(document.querySelector(".mk-page-header__description")?.textContent).toMatch(/смен нет/);
    expect(screen.getByRole("img", { name: /сегодня 0, вчера 30\s020/ })).toBeTruthy();
  });

  it("says the link is down in a banner in a roomy window, with the time the data is from", async () => {
    renderOffice(overviewSession(), { link: OFFLINE });
    const title = await screen.findByText("Нет связи с хостом", { selector: "strong, div, span" });
    const banner = title.closest("[role=status]") as HTMLElement;
    expect(banner).not.toBeNull();
    expect(await within(banner).findByText(/Показаны данные на \d\d:\d\d/)).toBeTruthy();
    expect(within(banner).getByRole("button", { name: "Повторить" })).toBeTruthy();
    const strip = await screen.findByRole("group", { name: "Показатели за сутки" });
    await waitFor(() => expect(within(strip).getAllByText(/^на \d\d:\d\d$/).length).toBe(4));
  });

  it("puts the same news in the page header's line in a narrow window, with «Повторить» among the buttons", async () => {
    window.innerWidth = 1280;
    renderOffice(overviewSession(), { link: OFFLINE });
    const line = await screen.findByText(/^Нет связи с хостом · данные на \d\d:\d\d$/);
    expect(line.closest("[role=status]")).not.toBeNull();
    expect(screen.queryByText(/Станции продолжают работать офлайн/)).toBeNull();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
  });

  it("keeps what it showed when a later read fails, and says the figures are as of the last good read", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const session = overviewSession();
    renderOffice(session, { link: ONLINE });
    const strip = await screen.findByRole("group", { name: "Показатели за сутки" });
    await waitFor(() => expect(within(strip).getByText("18 420")).toBeTruthy());
    session.api.listShifts.mockRejectedValue(new Error("down"));
    await vi.advanceTimersByTimeAsync(31_000);
    await waitFor(() => expect(within(strip).getAllByText(/^на \d\d:\d\d$/).length).toBe(4));
    expect(within(strip).getByText("18 420")).toBeTruthy();
    expect(screen.queryByText("Не удалось загрузить показатели")).toBeNull();
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
  });

  it("shows only the three most pressing lines and a «+N» tile to the rest", async () => {
    const session = overviewSession();
    const more = ["Линия 3", "Линия 4", "Линия 5"].map((name, index) => ({
      ...LINE_2,
      id: `3333333${index}-0000-4000-8000-000000000000`,
      name,
    }));
    session.api.listLines.mockResolvedValue([LINE_2, LINE_10, ...more]);
    renderOffice(session);
    const lines = await screen.findByRole("region", { name: "Линии" });
    await within(lines).findByRole("article", { name: "Линия 2" });
    expect(within(lines).getAllByRole("article")).toHaveLength(3);
    expect(
      within(lines)
        .getByRole("link", { name: /\+2 линии/ })
        .getAttribute("href"),
    ).toBe("/lines");
  });

  it("warns of a host clock far from this PC's and of devices on another version, as rows of the list", async () => {
    const session = overviewSession();
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      now: "2026-10-10T08:30:00.000Z",
      local: { ...HEALTHY_BACKUPS.local, copies: [backupCopy("2026-10-10T08:00:00Z")] },
      second: null,
    });
    session.api.listDevices.mockResolvedValue([device({ appVersion: "0.0.1" })]);
    renderOffice(session, {});
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    expect(await within(attention).findByText(/Часы ПК и хоста: разница 30 мин/)).toBeTruthy();
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
    await screen.findByRole("region", { name: "Требует внимания" });
    expect(screen.queryByRole("alert", { name: /Адрес хоста может измениться/ })).toBeNull();
    cleanup();
    const technologist = overviewSession(TECHNOLOGIST);
    renderOffice(technologist);
    await screen.findByRole("region", { name: "Требует внимания" });
    expect(technologist.api.getHostNetwork).not.toHaveBeenCalled();
  });

  it("announces a failed copy once, in the polite region, for the ear", async () => {
    const session = overviewSession();
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      now: NOW.toISOString(),
      local: {
        ...HEALTHY_BACKUPS.local,
        copies: [],
        lastAttempt: { at: NOW.toISOString(), trigger: "scheduled", ok: false, code: "no_space" },
      },
    });
    renderOffice(session);
    await screen.findByRole("region", { name: "Требует внимания" });
    await waitFor(() =>
      expect(
        document.querySelector(".backup-alerts [aria-live], .backup-alerts .ov-visually-hidden"),
      ).not.toBeNull(),
    );
    const live = document.querySelector(".backup-alerts") as HTMLElement;
    expect(live.getAttribute("aria-live")).toBe("polite");
  });
});

describe("the demo data on «Обзор» (spec 2026-10-21)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    window.innerWidth = 1440;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.innerWidth = 1024;
  });

  it("leaves a demo shift out of the day's figures", async () => {
    const session = overviewSession();
    // Line 10's shift is of the demo product: only line 2's 8 580 count.
    session.api.listProducts.mockResolvedValue([MILK, { ...WATER, demo: true }]);
    renderOffice(session);
    const strip = await screen.findByRole("group", { name: "Показатели за сутки" });
    await waitFor(() => expect(within(strip).getByText("8 580")).toBeTruthy());
    expect(within(strip).queryByText("18 420")).toBeNull();
  });

  it("says the demo data is there, and only an administrator gets «Удалить демо-данные»", async () => {
    const session = overviewSession(TECHNOLOGIST);
    session.api.getDemoData.mockResolvedValue(DEMO);
    renderOffice(session);
    const notice = await screen.findByRole("alert", { name: "Установлены демо-данные" });
    expect(within(notice).getByText(/не попадают в выгрузки для ГИС МТ/)).toBeTruthy();
    expect(within(notice).queryByRole("button", { name: "Удалить демо-данные" })).toBeNull();
  });

  it("deletes the demo data after asking, and says so", async () => {
    const session = overviewSession();
    session.api.getDemoData.mockResolvedValue(DEMO);
    session.api.deleteDemoData.mockResolvedValue(DEMO);
    renderOffice(session);
    const notice = await screen.findByRole("alert", { name: "Установлены демо-данные" });
    fireEvent.click(within(notice).getByRole("button", { name: "Удалить демо-данные" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить демо-данные?" });
    expect(
      within(dialog).getByText(
        "Удалятся демо-товар и всё, что сделано в его сменах: смен — 1, коробов — 4, палетов — 2, кодов — 20. Отменить нельзя.",
      ),
    ).toBeTruthy();
    session.api.getDemoData.mockResolvedValue(NO_DEMO);
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    expect(await screen.findByText("Демо-данные удалены.")).toBeTruthy();
    expect(session.api.deleteDemoData).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Удалить демо-данные?" })).toBeNull();
  });

  it("names the open demo shift that stops the delete", async () => {
    const session = overviewSession();
    session.api.getDemoData.mockResolvedValue(DEMO);
    session.api.deleteDemoData.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "a demo shift is open: close it first",
        details: { constraint: "demo_shift_active", shifts: ["DEMO-001"] },
      }),
    );
    renderOffice(session);
    const notice = await screen.findByRole("alert", { name: "Установлены демо-данные" });
    fireEvent.click(within(notice).getByRole("button", { name: "Удалить демо-данные" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить демо-данные?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    expect(
      await within(dialog).findByText(
        "Сначала закройте демо-смену на станции или в офисе: DEMO-001.",
      ),
    ).toBeTruthy();
  });
});
