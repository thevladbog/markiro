import { describe, expect, it } from "vitest";

import type { DeviceRecord, OfficeShift } from "../src/host/protocol.js";
import {
  attentionItems,
  chartScale,
  dayFigures,
  firstSteps,
  formatDuration,
  IDLE_AFTER_MS,
  lineCards,
  recentDays,
  shiftDayRow,
  signedDifference,
} from "../src/office/overview/dashboard-model.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";
import { licenseOf } from "./support/license.js";
import {
  ACTIVE,
  CLOSED,
  LINE_10,
  LINE_2,
  MILK,
  OLD_LINE,
  PLANNED,
  WATER,
} from "./support/shifts.js";

const NOW = Date.parse("2026-10-08T10:00:00Z");

function shift(
  overrides: Omit<Partial<OfficeShift>, "totals"> & { totals?: Partial<OfficeShift["totals"]> },
): OfficeShift {
  const { totals, ...rest } = overrides;
  return { ...ACTIVE, ...rest, totals: { ...ACTIVE.totals, ...totals } };
}

describe("a day's figures from the shifts' own date", () => {
  it("sums the units, boxes and pallets of the day's shifts that have begun, counting a validation shift by its accepted codes", () => {
    const shifts = [
      shift({
        id: "a",
        plannedDate: "2026-10-08",
        totals: { unitsInClosedBoxes: 500, closedBoxes: 40, closedPallets: 1 },
      }),
      shift({
        id: "b",
        plannedDate: "2026-10-08",
        status: "closed",
        mode: "validation",
        totals: { acceptedUnits: 70, unitsInClosedBoxes: 0, closedBoxes: 0, closedPallets: 0 },
      }),
      shift({
        id: "c",
        plannedDate: "2026-10-08",
        status: "planned",
        totals: { unitsInClosedBoxes: 999 },
      }),
      shift({ id: "d", plannedDate: "2026-10-07", totals: { unitsInClosedBoxes: 111 } }),
    ];
    expect(dayFigures(shifts, "2026-10-08")).toEqual({
      date: "2026-10-08",
      units: 570,
      boxes: 40,
      pallets: 1,
      shifts: 2,
    });
    expect(dayFigures(shifts, "2026-10-09")).toEqual({
      date: "2026-10-09",
      units: 0,
      boxes: 0,
      pallets: 0,
      shifts: 0,
    });
  });

  it("lists the last days oldest first, with the days without a shift as zeros", () => {
    const days = recentDays(
      [shift({ plannedDate: "2026-10-06", totals: { unitsInClosedBoxes: 10 } })],
      "2026-10-08",
      3,
    );
    expect(days.map((day) => [day.date, day.units])).toEqual([
      ["2026-10-06", 10],
      ["2026-10-07", 0],
      ["2026-10-08", 0],
    ]);
  });
});

describe("the chart's scale", () => {
  it("rounds the top up to a step of 1, 2 or 5 times a power of ten with at most four intervals", () => {
    expect(chartScale(31_400)).toEqual({ step: 10_000, top: 40_000 });
    expect(chartScale(18_420)).toEqual({ step: 5_000, top: 20_000 });
    expect(chartScale(2_800)).toEqual({ step: 1_000, top: 3_000 });
    expect(chartScale(30_000)).toEqual({ step: 10_000, top: 30_000 });
    expect(chartScale(7)).toEqual({ step: 2, top: 8 });
  });

  it("has a default for an empty week", () => {
    expect(chartScale(0)).toEqual({ step: 1_000, top: 3_000 });
  });
});

describe("a signed difference", () => {
  it("writes the sign in words as well as in the colour", () => {
    expect(signedDifference(18_420, 17_757)).toEqual({ text: "+663", direction: "up" });
    expect(signedDifference(930, 1_267)).toEqual({ text: "−337", direction: "down" });
    expect(signedDifference(5, 5)).toEqual({ text: "0", direction: "same" });
    expect(signedDifference(31_400, 0).text).toBe("+31 400");
  });
});

describe("durations", () => {
  it("picks minutes below an hour, hours below a day and days from there", () => {
    expect(formatDuration(47 * 60_000)).toEqual({ unit: "minutes", count: 47 });
    expect(formatDuration(90 * 60_000)).toEqual({ unit: "hours", count: 1 });
    expect(formatDuration(26 * 3_600_000)).toEqual({ unit: "hours", count: 26 });
    expect(formatDuration(49 * 3_600_000)).toEqual({ unit: "days", count: 2 });
    expect(formatDuration(0)).toEqual({ unit: "minutes", count: 0 });
  });
});

describe("the line cards", () => {
  const products = [MILK, WATER];
  const running = shift({
    id: "run",
    number: "OCT26-004",
    openedAt: "2026-10-08T06:00:00Z",
    plannedQty: 14_000,
    totals: { unitsInClosedBoxes: 9_840, lastFactAt: "2026-10-08T09:55:00Z" },
  });

  it("shows a running shift with its product, progress, pace by the average since it opened, and the expected end", () => {
    const { cards } = lineCards([running], [LINE_2], products, NOW, "2026-10-08");
    const card = cards[0];
    expect(card).toMatchObject({
      status: "running",
      productTitle: "Молоко 3,2%",
      done: 9_840,
      planned: 14_000,
      percent: 70,
      paceHourly: 2_460,
      idleMinutes: null,
    });
    // (14000 − 9840) / 2460 per hour = 1.691 h = 6 088 s after 10:00, i.e. about 11:41:28.
    expect(Math.abs((card?.etaAt ?? 0) - (NOW + 6_088_000))).toBeLessThan(1_000);
  });

  it("gives no progress and no end without a plan, and no end once the plan is met", () => {
    const noPlan = lineCards(
      [{ ...running, plannedQty: null }],
      [LINE_2],
      products,
      NOW,
      "2026-10-08",
    ).cards[0];
    expect(noPlan).toMatchObject({ planned: null, percent: null, etaAt: null });
    expect(noPlan?.paceHourly).toBe(2_460);
    const met = lineCards(
      [shift({ ...running, plannedQty: 9_000 })],
      [LINE_2],
      products,
      NOW,
      "2026-10-08",
    ).cards[0];
    expect(met?.etaAt).toBeNull();
    expect(met?.percent).toBe(100);
  });

  it("gives no pace in the first minutes of a shift, when an average says nothing", () => {
    const fresh = shift({
      openedAt: "2026-10-08T09:55:00Z",
      totals: { unitsInClosedBoxes: 50, lastFactAt: "2026-10-08T09:59:00Z" },
    });
    expect(
      lineCards([fresh], [LINE_2], products, NOW, "2026-10-08").cards[0]?.paceHourly,
    ).toBeNull();
  });

  it("calls a line idle when its last fact is older than ten minutes, and not at exactly ten", () => {
    const at = (ms: number) =>
      shift({
        openedAt: "2026-10-08T06:00:00Z",
        totals: { lastFactAt: new Date(NOW - ms).toISOString() },
      });
    expect(
      lineCards([at(IDLE_AFTER_MS)], [LINE_2], products, NOW, "2026-10-08").cards[0]?.status,
    ).toBe("running");
    const idle = lineCards([at(IDLE_AFTER_MS + 60_000)], [LINE_2], products, NOW, "2026-10-08")
      .cards[0];
    expect(idle).toMatchObject({ status: "idle", idleMinutes: 11, etaAt: null });
  });

  it("measures a shift without a fact yet from when it opened", () => {
    const quiet = shift({
      openedAt: "2026-10-08T09:30:00Z",
      totals: { lastFactAt: null, unitsInClosedBoxes: 0 },
    });
    expect(lineCards([quiet], [LINE_2], products, NOW, "2026-10-08").cards[0]).toMatchObject({
      status: "idle",
      idleMinutes: 30,
    });
  });

  it("shows a line without a shift as such, with its last closed shift and the plan for today", () => {
    const closed = { ...CLOSED, lineId: LINE_10.id, plannedDate: "2026-10-08" };
    const planned = {
      ...PLANNED,
      lineId: LINE_10.id,
      plannedDate: "2026-10-08",
      plannedQty: 8_000,
    };
    const card = lineCards([closed, planned], [LINE_10], products, NOW, "2026-10-08").cards[0];
    expect(card?.status).toBe("none");
    expect(card?.lastClosed?.number).toBe(CLOSED.number);
    expect(card?.nextPlanned?.number).toBe(PLANNED.number);
    expect(card?.productTitle).toBeNull();
  });

  it("leaves out an archived line unless it has a running shift", () => {
    const withArchived = lineCards(
      [{ ...running, lineId: OLD_LINE.id }],
      [OLD_LINE],
      products,
      NOW,
      "2026-10-08",
    );
    expect(withArchived.cards).toHaveLength(1);
    expect(lineCards([], [OLD_LINE], products, NOW, "2026-10-08").cards).toHaveLength(0);
  });

  it("picks the most pressing three of many (idle, running, without a shift) and shows them in the order of their names", () => {
    const idleShift = shift({
      id: "idle",
      lineId: "l4",
      openedAt: "2026-10-08T06:00:00Z",
      totals: { lastFactAt: "2026-10-08T08:00:00Z" },
    });
    const runningShift = { ...running, lineId: "l3" };
    const lines = ["Линия 1", "Линия 2", "Линия 3", "Линия 4"].map((name, index) => ({
      ...LINE_2,
      id: `l${index + 1}`,
      name,
    }));
    const out = lineCards([runningShift, idleShift], lines, products, NOW, "2026-10-08");
    // Picked: the idle «Линия 4», the running «Линия 3», then «Линия 1»; «Линия 2» is the +1.
    expect(out.cards.map((card) => card.line.name)).toEqual(["Линия 1", "Линия 3", "Линия 4"]);
    expect(out.hidden).toBe(1);
    expect(out.all.map((card) => card.line.name)).toEqual([
      "Линия 4",
      "Линия 3",
      "Линия 1",
      "Линия 2",
    ]);
  });

  it("shows the three most pressing lines and counts the rest", () => {
    const lines = ["Линия 1", "Линия 2", "Линия 3", "Линия 4", "Линия 5"].map((name, index) => ({
      ...LINE_2,
      id: `l${index}`,
      name,
    }));
    const out = lineCards([], lines, products, NOW, "2026-10-08");
    expect(out.cards.map((card) => card.line.name)).toEqual(["Линия 1", "Линия 2", "Линия 3"]);
    expect(out.hidden).toBe(2);
  });

  it("orders line names as numbers", () => {
    const lines = ["Линия 10", "Линия 2"].map((name, index) => ({
      ...LINE_2,
      id: `l${index}`,
      name,
    }));
    expect(
      lineCards([], lines, products, NOW, "2026-10-08").cards.map((card) => card.line.name),
    ).toEqual(["Линия 2", "Линия 10"]);
  });
});

describe("the shifts of a day", () => {
  it("counts the shifts at work, the planned ones with their plan, and the closed ones", () => {
    const shifts = [
      ACTIVE,
      shift({ id: "p1", status: "planned", plannedDate: "2026-10-08", plannedQty: 16_000 }),
      shift({ id: "p2", status: "planned", plannedDate: "2026-10-08", plannedQty: null }),
      shift({ id: "c1", status: "closed", plannedDate: "2026-10-08" }),
      shift({ id: "p3", status: "planned", plannedDate: "2026-10-09", plannedQty: 22_000 }),
    ];
    expect(shiftDayRow(shifts, "2026-10-08", true)).toEqual({
      active: 1,
      planned: 2,
      closed: 1,
      planSum: 16_000,
    });
    expect(shiftDayRow(shifts, "2026-10-09", false)).toEqual({
      active: 0,
      planned: 1,
      closed: 0,
      planSum: 22_000,
    });
    expect(shiftDayRow([], "2026-10-09", false)).toEqual({
      active: 0,
      planned: 0,
      closed: 0,
      planSum: null,
    });
  });
});

function device(overrides: Partial<DeviceRecord>): DeviceRecord {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    kind: "station",
    name: "Склад",
    lineId: null,
    appVersion: "2.1.0",
    pairedAt: "2026-09-26T09:15:00Z",
    lastSeenAt: new Date(NOW).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

/** Copies of both folders made two hours before `NOW`, by the host's clock. */
const FRESH_BACKUPS = {
  ...HEALTHY_BACKUPS,
  now: new Date(NOW).toISOString(),
  local: {
    ...HEALTHY_BACKUPS.local,
    copies: [backupCopy(new Date(NOW - 2 * 3_600_000).toISOString())],
  },
  second: {
    ...HEALTHY_BACKUPS.local,
    copies: [backupCopy(new Date(NOW - 2 * 3_600_000).toISOString())],
  },
};

const CALM = {
  conflicts: { total: 0, oldestDetectedAt: null },
  devices: [device({})],
  backups: FRESH_BACKUPS,
  license: licenseOf({}),
  settings: {
    retentionDays: null,
    fileCount: 1,
    storedBytes: 10,
    originalBytes: 12,
    maxStoredBytes: 100,
  },
  hostVersion: "2.1.0",
  idleLines: [],
  nowMs: NOW,
  pcNowMs: NOW,
};

describe("«Требует внимания»", () => {
  it("is empty while all is well", () => {
    expect(attentionItems(CALM)).toEqual([]);
  });

  it("lists waiting conflicts as an error with the age of the oldest, and a way to them", () => {
    const [item] = attentionItems({
      ...CALM,
      conflicts: { total: 3, oldestDetectedAt: new Date(NOW - 52 * 3_600_000).toISOString() },
    });
    expect(item).toMatchObject({ kind: "conflicts", severity: "err", to: "/conflicts" });
    expect(item?.titleValues).toEqual({ count: 3 });
    expect(item?.detailValues).toEqual({ unit: "days", count: 2 });
  });

  it("does not claim an age when the conflicts are on more than one page", () => {
    const [item] = attentionItems({ ...CALM, conflicts: { total: 80, oldestDetectedAt: null } });
    expect(item?.detailKey).toBeNull();
  });

  it("lists a device silent for more than ten minutes, and one never heard from, and not one just inside the window", () => {
    const items = attentionItems({
      ...CALM,
      devices: [
        device({ id: "a", name: "Склад", lastSeenAt: new Date(NOW - 47 * 60_000).toISOString() }),
        device({ id: "b", name: "Новая", lastSeenAt: null }),
        device({ id: "c", name: "Рядом", lastSeenAt: new Date(NOW - 10 * 60_000).toISOString() }),
        device({ id: "d", name: "Снята", revokedAt: "2026-10-01T00:00:00Z", lastSeenAt: null }),
      ],
    });
    expect(items.map((item) => [item.id, item.severity])).toEqual([
      ["device-b", "warn"],
      ["device-a", "warn"],
    ]);
    expect(items[1]?.titleValues).toMatchObject({ name: "Склад", unit: "minutes", count: 47 });
    expect(items[1]?.to).toBe("/devices");
  });

  it("reads no devices for a role that cannot", () => {
    expect(attentionItems({ ...CALM, devices: null })).toEqual([]);
  });

  it("warns of a stale copy, of a license near its end, of the clock, of a full store and of a version", () => {
    const stale = {
      ...FRESH_BACKUPS,
      local: {
        ...FRESH_BACKUPS.local,
        copies: [backupCopy(new Date(NOW - 27 * 3_600_000).toISOString())],
      },
    };
    const items = attentionItems({
      ...CALM,
      backups: stale,
      license: licenseOf({ state: "expiring", daysLeft: 12 }),
      pcNowMs: NOW + 7 * 60_000,
      settings: { ...CALM.settings, storedBytes: 84 },
      devices: [device({ appVersion: "2.0.0" })],
    });
    expect(items.map((item) => item.kind).sort()).toEqual([
      "backup",
      "clock_skew",
      "license",
      "store_full",
      "version_skew",
    ]);
    expect(items.find((item) => item.kind === "backup")?.to).toBe("/backups");
    expect(items.find((item) => item.kind === "license")?.to).toBe("/about#license");
    expect(items.find((item) => item.kind === "clock_skew")?.titleValues).toEqual({ minutes: 7 });
    expect(items.find((item) => item.kind === "store_full")?.to).toBeNull();
  });

  it("does not warn of a clock at exactly five minutes, nor of a license that is fine", () => {
    expect(attentionItems({ ...CALM, pcNowMs: NOW + 5 * 60_000 })).toEqual([]);
  });

  it("names an idle line with the minutes of silence, and links to its shift", () => {
    const [item] = attentionItems({
      ...CALM,
      idleLines: [{ lineName: "Линия 2", shiftId: ACTIVE.id, minutes: 18 }],
    });
    expect(item).toMatchObject({
      kind: "line_idle",
      severity: "warn",
      to: `/shifts?shift=${ACTIVE.id}`,
    });
  });

  it("orders errors before warnings before notes, keeping the order within a severity", () => {
    const items = attentionItems({
      ...CALM,
      conflicts: { total: 1, oldestDetectedAt: null },
      devices: [device({ lastSeenAt: null })],
      license: licenseOf({ state: "restricted", opensNewShifts: false }),
    });
    expect(items.map((item) => [item.kind, item.severity])).toEqual([
      ["conflicts", "err"],
      ["license", "err"],
      ["device_silent", "warn"],
    ]);
  });
});

describe("the first steps", () => {
  const org = {
    name: "ООО «Атолл»",
    inn: "7701234567",
    gln: "4600682000013",
    gs1Prefixes: [],
    timeZone: "UTC",
    rev: 1,
  };
  it("ticks what the site already has", () => {
    const steps = firstSteps({ org, lines: [LINE_2], devices: [], products: [], shifts: [] });
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["profile", true],
      ["line", true],
      ["station", false],
      ["products", false],
      ["shift", false],
    ]);
  });

  it("takes an unfilled profile and archived lines as not done, and leaves the station step unknown without devices read", () => {
    const steps = firstSteps({
      org: { ...org, name: " " },
      lines: [OLD_LINE],
      devices: null,
      products: [MILK],
      shifts: [ACTIVE],
    });
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["profile", false],
      ["line", false],
      ["station", null],
      ["products", true],
      ["shift", true],
    ]);
  });
});
