import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inventoryEventSchema } from "@markiro/domain";
import { inventoryEvidenceKinds } from "../src/modules/device-grants/inventory-evidence-kinds";
describe("actual inventory wire action mapping", () => {
  const boxId = randomUUID();
  const base = {
    eventId: randomUUID(),
    deviceSequence: 1,
    operatorId: randomUUID(),
    scannedAt: "2026-09-13T10:00:00.000Z",
    kind: "item",
    normalizedIdentity: `item:${"a".repeat(64)}`,
    codeHash: "a".repeat(64),
    canonicalRaw: "01ABC\u001d91XYZ",
    activeProductionDate: "2026-09-13",
    localVerdict: "expected",
  };
  it("binds real kind=item add-item to repack and possible persisted auto-close", () => {
    const item = inventoryEventSchema.parse({
      ...base,
      repack: { action: "add-item", boxId, itemId: randomUUID(), position: 1, closeBox: true },
    });
    expect(inventoryEvidenceKinds(item)).toEqual(["inventory.repack.v1", "inventory.box.close.v1"]);
  });
  it("leaves open-box and correction recovery zero-cost", () => {
    const oldSscc = "000000000000000001";
    const open = inventoryEventSchema.parse({
      ...base,
      kind: "old_box",
      normalizedIdentity: `old_box:${oldSscc}`,
      codeHash: null,
      canonicalRaw: oldSscc,
      repack: {
        action: "open-box",
        boxId,
        oldSscc,
        newSscc: "000000000000000002",
        capacity: 1,
        productionDate: "2026-09-13",
      },
    });
    expect(inventoryEvidenceKinds(open)).toEqual([]);
    const correction = inventoryEventSchema.parse({
      ...base,
      kind: "repack_action",
      normalizedIdentity: `repack_action:clear-box:${boxId}`,
      codeHash: null,
      canonicalRaw: null,
      localVerdict: "repack-action",
      repack: { action: "clear-box", boxId, changedAt: base.scannedAt },
    });
    expect(inventoryEvidenceKinds(correction)).toEqual([]);
  });
  it("charges explicit incomplete close only as box close", () => {
    const event = inventoryEventSchema.parse({
      ...base,
      kind: "repack_action",
      normalizedIdentity: `repack_action:close-incomplete:${boxId}`,
      codeHash: null,
      canonicalRaw: null,
      localVerdict: "repack-action",
      repack: { action: "close-incomplete", boxId, changedAt: base.scannedAt },
    });
    expect(inventoryEvidenceKinds(event)).toEqual(["inventory.box.close.v1"]);
  });
});
