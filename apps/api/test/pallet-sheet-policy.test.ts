import { describe, expect, it } from "vitest";
import {
  assertPalletSheetClient,
  assertPalletSheetEntry,
  projectPalletSheetFields,
  supportsPalletSheetClient,
  type PalletSheetCaller,
} from "../src/modules/shifts/pallet-sheet-policy";
const cabinet: PalletSheetCaller = { kind: "cabinet" };
const station: PalletSheetCaller = {
  kind: "device",
  deviceKind: "station",
  capabilities: "older, pallet-sheet-v2",
};
const old: PalletSheetCaller = { kind: "device", deviceKind: "station", capabilities: "older" };
const spoofed: PalletSheetCaller = {
  kind: "device",
  deviceKind: "handheld",
  capabilities: "pallet-sheet-v2",
};
describe("pallet sheet capability policy", () => {
  it.each([
    [cabinet, true],
    [station, true],
    [old, false],
    [spoofed, false],
  ])("checks actual device kind as well as advertised protocol", (caller, expected) => {
    expect(supportsPalletSheetClient(caller as PalletSheetCaller)).toBe(expected);
  });
  it("refuses explicit A4 operations for legacy and forged handheld callers", () => {
    expect(() => assertPalletSheetClient(old)).toThrow();
    expect(() => assertPalletSheetClient(spoofed)).toThrow();
    expect(() => assertPalletSheetClient(station)).not.toThrow();
  });
  it("refuses A4-only entry but keeps an explicit V1 fallback available", () => {
    const shift = { palletSheetTemplateId: "sheet", palletLabelTemplateId: null };
    expect(() => assertPalletSheetEntry(shift, old)).toThrow();
    expect(() => assertPalletSheetEntry(shift, spoofed)).toThrow();
    expect(() =>
      assertPalletSheetEntry({ ...shift, palletLabelTemplateId: "legacy" }, old),
    ).not.toThrow();
  });
  it("projects every V2 slot out of legacy responses without mutating the source", () => {
    const value = {
      id: "shift",
      palletLabelTemplateId: "legacy",
      palletSheetTemplateId: "sheet",
      palletSheetTemplateName: "A4",
      palletSheetTemplateRevision: 1,
      palletSheetTemplateSnapshot: { revision: 1 },
      palletSheetTemplate: { spec: "V2" },
      defaultPalletSheetTemplateId: "sheet",
      palletSheetProtocol: "pallet-sheet-v2",
    };
    const projected = projectPalletSheetFields(value, spoofed);
    expect(projected).toEqual({ id: "shift", palletLabelTemplateId: "legacy" });
    expect(projectPalletSheetFields(value, station)).toEqual(value);
    expect(projectPalletSheetFields(value, cabinet, false)).toEqual({
      id: "shift",
      palletLabelTemplateId: "legacy",
    });
    expect(value.palletSheetTemplateId).toBe("sheet");
  });
});
