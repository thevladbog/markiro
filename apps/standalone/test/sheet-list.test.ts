import { describe, expect, it } from "vitest";

import { buildDefaultLabelTemplates, buildPalletSheetPresets } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { PalletSheet } from "../src/host/protocol.js";
import {
  duplicateSheetNames,
  inUseShiftIds,
  MAX_SHEET_FILE_BYTES,
  missingPresets,
  sheetExport,
  sheetFailureKey,
  sheetFileName,
  sheetImport,
  sheetLayoutKey,
  sheetNameTaken,
} from "../src/office/sheets/sheet-list.js";

const PRESETS = buildPalletSheetPresets();

function sheet(index: number, extra: Partial<PalletSheet> = {}): PalletSheet {
  const preset = PRESETS[index];
  if (preset === undefined) throw new Error("no such preset");
  return {
    id: `6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5${index}`,
    name: preset.name,
    enabled: true,
    presetKey: preset.key,
    revision: 1,
    spec: preset.spec,
    ...extra,
  };
}

function api(code: string, details: Record<string, unknown> = {}) {
  return new HostError({ kind: "api", code, status: 409, message: "", details });
}

const SHIFT_A = "11111111-2222-4333-8444-555555555551";
const SHIFT_B = "11111111-2222-4333-8444-555555555552";

describe("sheet-list", () => {
  it("names the layout of each stock sheet", () => {
    expect(PRESETS.map((preset) => sheetLayoutKey(preset.spec))).toEqual([
      "portrait",
      "landscape",
      "twoA5",
    ]);
    expect(sheetLayoutKey({ widthMm: 58 })).toBeNull();
  });

  it("offers only the stock sheets not added yet", () => {
    expect(missingPresets([sheet(0)]).map((preset) => preset.key)).toEqual([
      "pallet-a4-landscape",
      "pallet-a4-two-a5",
    ]);
    expect(missingPresets([sheet(0), sheet(1), sheet(2)])).toEqual([]);
    // A renamed stock sheet still carries its key: it is not offered again.
    expect(missingPresets([sheet(0, { name: "Мой лист" })]).length).toBe(2);
    // A sheet of the office's own (no key) never hides a stock one.
    expect(missingPresets([sheet(0, { presetKey: null })]).length).toBe(3);
  });

  it("round-trips a sheet through its JSON without its id or revision", () => {
    const text = sheetExport(sheet(1));
    expect(text).not.toContain(sheet(1).id);
    expect(text).not.toContain("revision");
    expect(JSON.parse(text)).toMatchObject({ name: sheet(1).name, purpose: "pallet" });
    const back = sheetImport(text);
    expect(back.name).toBe(sheet(1).name);
    expect(back.spec).toEqual(sheet(1).spec);
    // export -> import -> export keeps the file as it was
    expect(sheetExport({ ...sheet(1), name: back.name, spec: back.spec })).toBe(text);
  });

  it("refuses to export a sheet this build cannot read", () => {
    expect(() => sheetExport(sheet(0, { spec: { widthMm: 58 } }))).toThrow();
  });

  it("refuses a label template, a bare spec, a wrong purpose and a broken file", () => {
    expect(() =>
      sheetImport(JSON.stringify({ name: "x", purpose: "box", spec: { widthMm: 58 } })),
    ).toThrow();
    expect(() =>
      sheetImport(JSON.stringify({ name: "x", purpose: "pallet", spec: { widthMm: 58 } })),
    ).toThrow();
    expect(() => sheetImport("{")).toThrow();
    // a valid label template under the pallet purpose is still not a sheet
    const stock = buildDefaultLabelTemplates()[0];
    if (stock === undefined) throw new Error("no stock label template");
    const label = JSON.stringify({ name: stock.name, purpose: "pallet", spec: stock.spec });
    expect(() => sheetImport(label)).toThrow("not an A4 sheet");
    expect(() => sheetImport(JSON.stringify(PRESETS[0]?.spec))).toThrow();
    // a sheet filed under a box purpose
    expect(() =>
      sheetImport(JSON.stringify({ name: "x", purpose: "box", spec: PRESETS[0]?.spec })),
    ).toThrow();
    // an unknown property of a sheet is not stripped
    expect(() =>
      sheetImport(
        JSON.stringify({
          name: "x",
          purpose: "pallet",
          spec: { ...(PRESETS[0]?.spec as object), stray: 1 },
        }),
      ),
    ).toThrow();
  });

  it("keeps the imported name trimmed and refuses a blank one", () => {
    const body = (name: string) =>
      JSON.stringify({ name, purpose: "pallet", spec: PRESETS[0]?.spec });
    expect(sheetImport(body("  Лист цеха  ")).name).toBe("Лист цеха");
    expect(() => sheetImport(body("   "))).toThrow();
  });

  it("bounds a file at 256 KiB", () => {
    expect(MAX_SHEET_FILE_BYTES).toBe(256 * 1024);
  });

  it("says why the host refused a write", () => {
    const conflict = (constraint: string) => api("conflict", { constraint });
    expect(sheetFailureKey(conflict("template_is_default"))).toBe(
      "office.palletSheets.errors.isDefault",
    );
    expect(sheetFailureKey(conflict("template_in_use"))).toBe("office.palletSheets.errors.inUse");
    expect(sheetFailureKey(conflict("something_else"))).toBe("office.palletSheets.errors.failed");
    expect(sheetFailureKey(api("stale_revision"))).toBe("office.palletSheets.errors.stale");
    expect(sheetFailureKey(api("validation_failed"))).toBe("office.palletSheets.errors.invalid");
    expect(sheetFailureKey(api("not_found"))).toBe("office.palletSheets.errors.missing");
    expect(sheetFailureKey(api("forbidden"))).toBe("office.palletSheets.errors.failed");
    // the constraint names a conflict only: no other code is read by it
    expect(sheetFailureKey(api("validation_failed", { constraint: "template_in_use" }))).toBe(
      "office.palletSheets.errors.invalid",
    );
    expect(sheetFailureKey(api("not_found", { constraint: "template_is_default" }))).toBe(
      "office.palletSheets.errors.missing",
    );
    expect(sheetFailureKey(new Error("x"))).toBe("office.palletSheets.errors.failed");
  });

  it("reads the planned shifts that hold a sheet from the refusal", () => {
    const inUse = api("conflict", { constraint: "template_in_use", shiftIds: [SHIFT_A, SHIFT_B] });
    expect(inUseShiftIds(inUse)).toEqual([SHIFT_A, SHIFT_B]);
    // a refusal that is not "in use" names none, whatever else it carries
    expect(
      inUseShiftIds(api("conflict", { constraint: "template_is_default", shiftIds: [SHIFT_A] })),
    ).toBeNull();
    expect(inUseShiftIds(api("validation_failed", { shiftIds: [SHIFT_A] }))).toBeNull();
    expect(
      inUseShiftIds(
        api("validation_failed", { constraint: "template_in_use", shiftIds: [SHIFT_A] }),
      ),
    ).toBeNull();
    // no list, or one that is not ids: the refusal is still "in use", with nothing to list
    expect(inUseShiftIds(api("conflict", { constraint: "template_in_use" }))).toEqual([]);
    expect(
      inUseShiftIds(api("conflict", { constraint: "template_in_use", shiftIds: [1, "a"] })),
    ).toEqual([]);
    expect(inUseShiftIds(new Error("x"))).toBeNull();
  });

  it("finds sheets that share a name, ignoring case and spaces at the ends", () => {
    const list = [
      sheet(0, { name: "Лист цеха" }),
      sheet(1, { name: " лист ЦЕХА " }),
      sheet(2, { name: "Другой" }),
    ];
    expect(duplicateSheetNames(list)).toEqual(["Лист цеха"]);
    expect(duplicateSheetNames([sheet(0), sheet(1), sheet(2)])).toEqual([]);
    expect(sheetNameTaken(list, "ЛИСТ цеха", sheet(0).id)).toBe(true);
    // a sheet is not a duplicate of itself
    expect(sheetNameTaken(list, "Другой", sheet(2).id)).toBe(false);
    expect(sheetNameTaken(list, "Новое имя", sheet(2).id)).toBe(false);
  });

  it("makes a download name of a sheet's name", () => {
    expect(sheetFileName("Лист цеха")).toBe("Лист цеха.json");
    expect(sheetFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j.json");
    expect(sheetFileName("  ")).toBe("лист.json");
    expect(sheetFileName("tab\there")).toBe("tab_here.json");
  });
});
