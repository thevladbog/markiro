import { describe, expect, it } from "vitest";

import { buildPalletSheetPresets } from "@markiro/domain";

import type { PalletSheet, PalletSheets } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import { sheetOptions } from "../src/office/shifts/sheet-options.js";

const PRESETS = buildPalletSheetPresets();
const t = i18n.t.bind(i18n);

function sheet(index: number, extra: Partial<PalletSheet> = {}): PalletSheet {
  const preset = PRESETS[index];
  if (preset === undefined) throw new Error("no such preset");
  return {
    id: `${String(index)}a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a50`,
    name: `Лист ${String(index)}`,
    enabled: true,
    presetKey: preset.key,
    revision: 1,
    spec: preset.spec,
    ...extra,
  };
}

function lists(sheets: PalletSheet[], defaultId: string | null = null): PalletSheets {
  return { sheets, defaultId };
}

const labels = (options: { label: string }[]) => options.map((option) => option.label);

describe("the choices of a shift's A4 sheet", () => {
  it("offers the main sheet first for a shift without a sheet, then the enabled sheets by name", () => {
    const list = lists([sheet(2), sheet(0), sheet(1)], sheet(0).id);
    const options = sheetOptions(list, null, "", t);
    expect(options).toEqual([
      { value: "", label: "Основной лист организации (Лист 0)" },
      { value: sheet(0).id, label: "Лист 0" },
      { value: sheet(1).id, label: "Лист 1" },
      { value: sheet(2).id, label: "Лист 2" },
    ]);
  });

  it("says when there is no main sheet", () => {
    expect(labels(sheetOptions(lists([sheet(0)]), null, "", t))[0]).toBe(
      "Основной лист организации (не выбран)",
    );
    // A main sheet that is switched off is not one the host would take.
    expect(
      labels(sheetOptions(lists([sheet(0, { enabled: false })], sheet(0).id), null, "", t))[0],
    ).toBe("Основной лист организации (не выбран)");
  });

  it("does not offer «main» to a shift that already has a sheet: the host cannot clear it", () => {
    const options = sheetOptions(
      lists([sheet(0), sheet(1)], sheet(0).id),
      sheet(1).id,
      sheet(1).id,
      t,
    );
    expect(options.map((option) => option.value)).toEqual([sheet(0).id, sheet(1).id]);
  });

  it("keeps the sheet a shift holds, marked, when it was switched off, cannot be read or is gone", () => {
    const off = sheetOptions(
      lists([sheet(0), sheet(1, { enabled: false })]),
      sheet(1).id,
      sheet(1).id,
      t,
    );
    expect(off).toContainEqual({ value: sheet(1).id, label: "Лист 1 (выключен)" });
    expect(off.filter((option) => option.value === sheet(1).id)).toHaveLength(1);
    const unreadable = sheetOptions(
      lists([sheet(0), sheet(1, { spec: { widthMm: 58 } })]),
      sheet(1).id,
      sheet(1).id,
      t,
    );
    expect(unreadable).toContainEqual({
      value: sheet(1).id,
      label: "Лист 1 (не читается этой версией)",
    });
    const gone = sheetOptions(lists([sheet(0)]), sheet(1).id, sheet(1).id, t);
    expect(gone).toContainEqual({ value: sheet(1).id, label: "Лист 1a3f0c5e" });
    // While the list did not load, the held sheet is the only choice but "main".
    expect(sheetOptions(undefined, sheet(1).id, sheet(1).id, t)).toEqual([
      { value: sheet(1).id, label: "Лист 1a3f0c5e" },
    ]);
  });

  it("keeps the sheet a shift holds when another one is chosen over it", () => {
    const options = sheetOptions(
      lists([sheet(0), sheet(1, { enabled: false }), sheet(2)]),
      sheet(1).id,
      sheet(2).id,
      t,
    );
    expect(options).toContainEqual({ value: sheet(1).id, label: "Лист 1 (выключен)" });
    expect(options).toContainEqual({ value: sheet(2).id, label: "Лист 2" });
    expect(options.filter((option) => option.value === sheet(2).id)).toHaveLength(1);
  });

  it("keeps a sheet the form holds that the list no longer offers (refused meanwhile)", () => {
    const options = sheetOptions(
      lists([sheet(0), sheet(1, { enabled: false })]),
      null,
      sheet(1).id,
      t,
    );
    expect(options).toContainEqual({ value: sheet(1).id, label: "Лист 1 (выключен)" });
  });

  it("offers no sheet a new shift could not print: switched off or unreadable", () => {
    const options = sheetOptions(
      lists([sheet(0), sheet(1, { enabled: false }), sheet(2, { spec: { widthMm: 58 } })]),
      null,
      "",
      t,
    );
    expect(options.map((option) => option.value)).toEqual(["", sheet(0).id]);
  });

  it("tells sheets that share a name apart by the start of their id", () => {
    const options = sheetOptions(
      lists([sheet(0, { name: "Лист цеха" }), sheet(1, { name: " лист ЦЕХА " }), sheet(2)]),
      null,
      "",
      t,
    );
    expect([...labels(options)].sort()).toEqual(
      [
        "Основной лист организации (не выбран)",
        "Лист цеха · 0a3f0c5e",
        "лист ЦЕХА · 1a3f0c5e",
        "Лист 2",
      ].sort(),
    );
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });

  it("shows only «main» while the list did not load, for a shift without a sheet", () => {
    expect(sheetOptions(undefined, null, "", t)).toEqual([
      { value: "", label: "Основной лист организации (не выбран)" },
    ]);
  });
});
