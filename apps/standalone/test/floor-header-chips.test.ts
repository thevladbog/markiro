import { describe, expect, it } from "vitest";

import {
  chipForm,
  chipKinds,
  linkChip,
  minCollapseLevel,
  nextCollapseLevel,
  operatorForm,
  overflows,
  printerChip,
  queueChips,
  scannerChip,
  type BarMeasure,
} from "../src/floor/header-chips.js";

const fits: BarMeasure = { barWidth: 1280, railWidth: 700, identityWidth: 300, gap: 16 };
const tight: BarMeasure = { barWidth: 1000, railWidth: 700, identityWidth: 300, gap: 16 };

describe("which chips a screen of the floor shows", () => {
  it("sign-in: the link and the scanner only (nobody is in, no printer to speak of)", () => {
    expect(chipKinds("sign-in")).toEqual(["link", "scanner"]);
  });
  it("the hub and the forms: link, printer, scanner; the queue is the footer's button", () => {
    expect(chipKinds("hub")).toEqual(["link", "printer", "scanner"]);
  });
  it("the work screen: all four", () => {
    expect(chipKinds("work")).toEqual(["link", "printer", "scanner", "queue"]);
  });
});

describe("the header's collapse decision", () => {
  it("keeps everything while the bar holds the identity, the chips and the rail", () => {
    expect(overflows(fits)).toBe(false);
    expect(nextCollapseLevel(0, fits, 0)).toBe(0);
  });
  it("collapses by priority, one step per measurement: healthy chips, then the operator button", () => {
    expect(overflows(tight)).toBe(true);
    expect(nextCollapseLevel(0, tight, 0)).toBe(1);
    expect(nextCollapseLevel(1, tight, 0)).toBe(2);
  });
  it("stops at the last step: the station name is then cut by an ellipsis, never wrapped", () => {
    expect(nextCollapseLevel(2, tight, 0)).toBe(2);
  });
  it("never goes under the screen's minimum: the work screen's four chips start collapsed", () => {
    expect(minCollapseLevel("work")).toBe(1);
    expect(minCollapseLevel("hub")).toBe(0);
    expect(nextCollapseLevel(0, fits, 1)).toBe(1);
  });
  it("counts the identity at its most (a long name is cut, it does not push the chips)", () => {
    const long: BarMeasure = { ...fits, barWidth: 1100, identityWidth: 900 };
    // 360 px at most for the identity: 360 + 16 + 700 = 1076 <= 1100.
    expect(overflows(long)).toBe(false);
    expect(overflows({ ...long, barWidth: 1070 })).toBe(true);
  });
  it("collapses healthy chips only: a problem keeps its words at every level", () => {
    for (const tone of ["ok", "neutral"] as const) {
      expect(chipForm(0, tone)).toBe("full");
      expect(chipForm(1, tone)).toBe("icon");
      expect(chipForm(2, tone)).toBe("icon");
    }
    for (const tone of ["warn", "error"] as const) {
      expect(chipForm(0, tone)).toBe("full");
      expect(chipForm(2, tone)).toBe("full");
    }
  });
  it("turns «Сменить оператора» into an icon only at the second step", () => {
    expect(operatorForm(0)).toBe("text");
    expect(operatorForm(1)).toBe("text");
    expect(operatorForm(2)).toBe("icon");
  });
});

describe("the chips' states", () => {
  const online = { state: "online", lastContactAt: null, lastError: null, seq: 1 } as const;
  const sync = { kind: "done", synced: 1, failure: null, quarantined: 0 } as const;

  it("link: ok with a Wi-Fi glyph; weak while connecting or a sync fails; none without the host", () => {
    expect(linkChip(online, sync)).toMatchObject({ tone: "ok", icon: "wifi-high", text: "ok" });
    expect(linkChip({ ...online, state: "connecting" }, sync)).toMatchObject({
      tone: "warn",
      icon: "wifi-medium",
      text: "weak",
    });
    expect(linkChip(online, { ...sync, failure: "host" })).toMatchObject({
      tone: "warn",
      icon: "wifi-medium",
    });
    expect(linkChip({ ...online, state: "offline" }, sync)).toMatchObject({
      tone: "warn",
      icon: "wifi-slash",
      text: "none",
    });
    expect(linkChip(null, null)).toMatchObject({ tone: "neutral", text: "pending" });
  });

  it("printer: an error while a label of the shift waits failed or unknown, none without a printer", () => {
    expect(printerChip({ configured: true, failed: false })).toMatchObject({
      tone: "ok",
      text: "ok",
    });
    expect(printerChip({ configured: true, failed: true })).toMatchObject({
      tone: "error",
      text: "error",
    });
    expect(printerChip({ configured: false, failed: false })).toMatchObject({
      tone: "neutral",
      text: "none",
    });
    // A failed label outranks the missing printer: the operator has to see it.
    expect(printerChip({ configured: false, failed: true })).toMatchObject({ tone: "error" });
  });

  it("scanner: ready for the wedge and connected COM scanners, a part, none, unknown", () => {
    expect(scannerChip("keyboard")).toMatchObject({ tone: "ok", text: "ready" });
    expect(scannerChip("connected")).toMatchObject({ tone: "ok", text: "ready" });
    expect(scannerChip("partial")).toMatchObject({ tone: "warn", text: "partial" });
    expect(scannerChip("disconnected")).toMatchObject({
      tone: "error",
      icon: "plugs",
      text: "disconnected",
    });
    expect(scannerChip("unknown")).toMatchObject({ tone: "warn", text: "unknown" });
  });

  it("queue: neutral at 0, warn with N waiting, and a refusal as its own error chip", () => {
    expect(queueChips({ unsent: 0, rejected: 0, failing: false })).toEqual([
      expect.objectContaining({ kind: "queue", tone: "neutral", n: 0 }),
    ]);
    expect(queueChips({ unsent: 3, rejected: 0, failing: false })).toEqual([
      expect.objectContaining({ kind: "queue", tone: "warn", n: 3 }),
    ]);
    expect(queueChips({ unsent: 2, rejected: 2, failing: false })).toEqual([
      expect.objectContaining({ kind: "queue", tone: "warn", n: 2 }),
      expect.objectContaining({ kind: "rejected", tone: "error", n: 2 }),
    ]);
    // A failing send is a warning even with nothing counted yet.
    expect(queueChips({ unsent: 0, rejected: 0, failing: true })[0]).toMatchObject({
      tone: "warn",
    });
  });
});
