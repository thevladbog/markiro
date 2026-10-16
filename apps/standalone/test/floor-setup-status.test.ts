import { describe, expect, it } from "vitest";

import {
  unsavedParts,
  volumeDivisions,
  type UnsavedPart,
} from "../src/floor/setup/setup-status.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  type PrinterProfile,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";

const PRINTER: PrinterProfile = {
  id: "p1",
  name: "Zebra",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};

const base: WorkstationSettings = { ...DEFAULT_WORKSTATION_SETTINGS, printers: [PRINTER] };

describe("the words of «Не сохранено»", () => {
  it("is empty when the draft is what is stored", () => {
    expect(unsavedParts(base, structuredClone(base))).toEqual([]);
  });

  it.each<[string, WorkstationSettings, UnsavedPart[]]>([
    ["printers", { ...base, printers: [] }, ["printers"]],
    ["a changed printer", { ...base, printers: [{ ...PRINTER, dpi: 300 as const }] }, ["printers"]],
    ["the box", { ...base, assignments: { ...base.assignments, box: "p1" } }, ["assignment_box"]],
    [
      "the pallet and the duplicate",
      { ...base, assignments: { ...base.assignments, pallet: "p1", duplicate: "p1" } },
      ["assignment_pallet", "assignment_duplicate"],
    ],
    ["the label check", { ...base, verifyPrintedLabel: true }, ["verify"]],
    ["scanners", { ...base, scanners: [{ port: "COM9", baud: 9600 }] }, ["scanners"]],
    ["the sound switch", { ...base, sound: { ...base.sound, muted: true } }, ["sound"]],
    ["the volume", { ...base, sound: { ...base.sound, volume: 50 } }, ["volume"]],
  ])("names %s", (_name, draft, expected) => {
    expect(unsavedParts(base, draft)).toEqual(expected);
  });

  it("lists several changes in the order of the screen", () => {
    const draft: WorkstationSettings = {
      ...base,
      sound: { muted: true, volume: 10 },
      scanners: [{ port: "COM9", baud: 9600 }],
      printers: [],
    };
    expect(unsavedParts(base, draft)).toEqual(["printers", "scanners", "sound", "volume"]);
  });
});

describe("the volume scale", () => {
  it("fills a division per ten percent, and none when silent", () => {
    expect(volumeDivisions({ muted: false, volume: 80 })).toBe(8);
    expect(volumeDivisions({ muted: false, volume: 0 })).toBe(0);
    expect(volumeDivisions({ muted: false, volume: 100 })).toBe(10);
    expect(volumeDivisions({ muted: true, volume: 80 })).toBe(0);
  });
});
