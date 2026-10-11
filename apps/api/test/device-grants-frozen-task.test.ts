import { projectThermalInventoryManifest } from "../src/modules/inventories/thermal-label-policy";
import { parseStationInventoryManifest } from "../src/modules/inventories/station-inventory.dto";
import {
  buildDefaultLabelTemplates,
  projectThermalLabelForClient,
  THERMAL_LABEL_BRANDING_PROTOCOL,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  buildFrozenGrantTask,
  frozenPalletSheetScope,
} from "../src/modules/device-grants/frozen-task";
import { buildPalletSheetPresets, createPalletSheetSnapshot } from "@markiro/domain";
describe("frozen productive scope", () => {
  it("binds the saved A4 revision only for an actual capable station, preserving legacy scope", () => {
    const preset = buildPalletSheetPresets()[0];
    if (!preset) throw new Error("Missing preset");
    const snapshot = createPalletSheetSnapshot({
      id: "a1111111-1111-4111-8111-111111111111",
      name: "A4",
      revision: 1,
      spec: preset.spec,
    });
    const shift = {
      palletLabelTemplateId: "fallback",
      palletSheetTemplateId: snapshot.id,
      palletSheetTemplateSnapshot: snapshot,
    };
    expect(frozenPalletSheetScope(shift, "station", undefined)).toEqual({});
    expect(frozenPalletSheetScope(shift, "handheld", "pallet-sheet-v2")).toEqual({});
    expect(frozenPalletSheetScope(shift, "station", "pallet-sheet-v2")).toEqual({
      palletSheetTemplateId: snapshot.id,
      palletSheetTemplateSnapshot: snapshot,
    });
    expect(() =>
      frozenPalletSheetScope(
        { ...shift, palletLabelTemplateId: null },
        "handheld",
        "pallet-sheet-v2",
      ),
    ).toThrow();
    expect(() =>
      frozenPalletSheetScope(
        { ...shift, palletSheetTemplateSnapshot: { ...snapshot, revision: 2 } },
        "station",
        "pallet-sheet-v2",
      ),
    ).toThrow();
  });
  it("binds the same projected thermal print model as the legacy/current inventory bundle", () => {
    const spec = buildDefaultLabelTemplates().find((t) => t.name === "Коробка 100×150")!.spec;
    const manifest = parseStationInventoryManifest({
      inventoryId: "a1111111-1111-4111-8111-111111111111",
      inventoryNumber: "INV-1",
      snapshotId: "b1111111-1111-4111-8111-111111111111",
      snapshotRevision: 1,
      snapshotFixedAt: "2026-10-11T00:00:00.000Z",
      combinedDigest: "a".repeat(64),
      contentDigest: "b".repeat(64),
      codeCount: 0,
      productId: "c1111111-1111-4111-8111-111111111111",
      productName: "Product",
      productPrintName: null,
      egaisCode: null,
      shelfLifeDays: null,
      gtin14: "04680089900383",
      boxCapacity: 12,
      mode: "repack",
      lineId: "d1111111-1111-4111-8111-111111111111",
      lineName: "Line",
      productionDateFrom: "2026-10-01",
      productionDateTo: "2026-10-11",
      boxLabelTemplate: { id: "e1111111-1111-4111-8111-111111111111", name: "Box", spec },
      limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
    });
    const legacy = projectThermalInventoryManifest(manifest);
    const current = projectThermalInventoryManifest(manifest, THERMAL_LABEL_BRANDING_PROTOCOL);
    expect(legacy.boxLabelTemplate?.spec).toEqual(projectThermalLabelForClient(spec));
    expect(current.boxLabelTemplate?.spec).toEqual(spec);
    expect(manifest.boxLabelTemplate?.spec).toEqual(spec);
    const bounds = { "inventory.close.v1": { maxEvents: 1 } };
    expect(
      buildFrozenGrantTask(
        "inventory",
        manifest.inventoryId,
        { manifest: legacy },
        ["inventory.close.v1"],
        bounds,
      ),
    ).not.toEqual(
      buildFrozenGrantTask(
        "inventory",
        manifest.inventoryId,
        { manifest: current },
        ["inventory.close.v1"],
        bounds,
      ),
    );
  });
  const scope = { snapshotId: "saved-snapshot", contentDigest: "a".repeat(64), mode: "check" };
  it("requires every productive event dimension without synthesizing quantity", () => {
    expect(
      buildFrozenGrantTask("inventory", "task", scope, ["inventory.scan.v1"], {
        "inventory.scan.v1": { maxEvents: 3 },
      }),
    ).toEqual({ status: "denied", reason: "bounds_required" });
  });
  it("retains zero as an exhausted budget", () => {
    expect(
      buildFrozenGrantTask("inventory", "task", scope, ["inventory.scan.v1"], {
        "inventory.scan.v1": { maxEvents: 0, maxUnits: 0 },
      }),
    ).toMatchObject({
      status: "ready",
      task: {
        eventTypes: ["inventory.scan.v1"],
        budget: [
          { id: "inventory.scan.v1:events", maximum: 0 },
          { id: "inventory.scan.v1:units", maximum: 0 },
        ],
      },
    });
  });
  it("changes frozen identity with task scope but keeps same-scope retries stable", () => {
    const bounds = { "inventory.close.v1": { maxEvents: 1 } };
    const first = buildFrozenGrantTask("inventory", "task", scope, ["inventory.close.v1"], bounds);
    const same = buildFrozenGrantTask(
      "inventory",
      "task",
      { ...scope },
      ["inventory.close.v1"],
      bounds,
    );
    const changed = buildFrozenGrantTask(
      "inventory",
      "task",
      { ...scope, contentDigest: "b".repeat(64) },
      ["inventory.close.v1"],
      bounds,
    );
    expect(first).toEqual(same);
    expect(changed).not.toEqual(first);
  });
  it("does not turn missing event bounds into a wildcard", () => {
    expect(
      buildFrozenGrantTask("shift", "task", {}, ["shift.scan.v1", "shift.close.v1"], {
        "shift.scan.v1": { maxEvents: 5, maxUnits: 4 },
      }),
    ).toEqual({ status: "denied", reason: "bounds_required" });
  });
});
