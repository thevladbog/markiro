import { describe, expect, it } from "vitest";
import { createPalletSheetSnapshot, parsePalletSheetSpec } from "@markiro/domain";
function makeSheetSpec() {
  return parsePalletSheetSpec({
    schemaVersion: 2,
    kind: "pallet_sheet",
    dpi: 300,
    page: {
      size: "A4",
      orientation: "portrait",
      copies: 1,
      cutLine: false,
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    },
    body: [],
    footer: {
      id: "sscc",
      kind: "sscc",
      source: "sscc",
      barHeightMm: 45,
      moduleDots: 11,
      align: "center",
    },
  });
}
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
      palletSheetTemplateSnapshot: createPalletSheetSnapshot({
        id: "a1111111-1111-4111-8111-111111111111",
        name: "A4",
        revision: 1,
        spec: makeSheetSpec(),
      }),
      palletSheetTemplate: createPalletSheetSnapshot({
        id: "a1111111-1111-4111-8111-111111111111",
        name: "A4",
        revision: 1,
        spec: makeSheetSpec(),
      }),
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

describe("A4 footer capability policy", () => {
  const base = { spec: makeSheetSpec() };
  const spec = parsePalletSheetSpec({
    ...base.spec,
    footer: {
      ...base.spec.footer,
      caption: {
        fontSizePt: 8,
        separatorThicknessMm: 0.15,
        gapMm: 1,
        showInn: true,
        platformText: "Сформировано в Маркиро",
      },
    },
  });
  const capable: PalletSheetCaller = {
    ...station,
    capabilities: "pallet-sheet-v2,pallet-sheet-footer-v1",
  };
  const snapshot = createPalletSheetSnapshot({
    id: "a1111111-1111-4111-8111-111111111111",
    name: "A4",
    revision: 2,
    spec,
  });
  it("refuses a footer snapshot for an older v2 Station before entry or delivery", () => {
    expect(() => assertPalletSheetClient(station, spec)).toThrow("footer");
    expect(() =>
      assertPalletSheetEntry(
        { palletSheetTemplateId: snapshot.id, palletLabelTemplateId: null },
        station,
        snapshot.spec,
      ),
    ).toThrow("footer");
  });
  it("does not send extended snapshots to a strict legacy parser", () => {
    const value = { palletSheetTemplateSnapshot: snapshot };
    expect(() => projectPalletSheetFields(value, station)).toThrow("footer");
    expect(projectPalletSheetFields(value, capable)).toEqual(value);
  });
  it("permits supported clients and continues existing v2 shifts without the extension", () => {
    expect(() => assertPalletSheetClient(capable, spec)).not.toThrow();
    expect(() => assertPalletSheetClient(cabinet, spec)).not.toThrow();
    expect(() => assertPalletSheetClient(station, base.spec)).not.toThrow();
  });
});
