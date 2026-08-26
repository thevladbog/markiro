import { describe, expect, it } from "vitest";

import {
  createInventoryRepackingState,
  reduceInventoryRepacking,
  type InventoryRepackingState,
} from "../src/index.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const OLD_SSCC = "346006820000000014";
const NEW_SSCC = "046012345600000012";

function opened(capacity = 20): InventoryRepackingState {
  const initial = createInventoryRepackingState({
    ownerDeviceId: OWNER,
    capacity,
    activeProductionDate: "2026-08-19",
  });
  const selected = reduceInventoryRepacking(initial, {
    type: "select-old-box",
    deviceId: OWNER,
    oldSscc: OLD_SSCC,
    boxId: "33333333-3333-4333-8333-333333333333",
    newSscc: NEW_SSCC,
    openedAt: "2026-08-25T10:00:00.000Z",
  });
  if (!selected.ok) throw new Error(selected.reason);
  return selected.state;
}

function eligible(position: number, productionDate = "2026-08-19") {
  return {
    type: "observe-item" as const,
    deviceId: OWNER,
    observedAt: `2026-08-25T10:00:${String(position).padStart(2, "0")}.000Z`,
    item: {
      eventId: `44444444-4444-4444-8444-${String(position).padStart(12, "0")}`,
      codeHash: String(position).padStart(64, "a"),
      classification: "eligible" as const,
      observedProductionDate: productionDate,
      sourceParentSscc: OLD_SSCC,
    },
  };
}

describe("inventory repacking reducer", () => {
  it("rejects impossible transitions explicitly without mutating the input", () => {
    const state = createInventoryRepackingState({
      ownerDeviceId: OWNER,
      capacity: 20,
      activeProductionDate: "2026-08-19",
    });
    const result = reduceInventoryRepacking(state, eligible(1));
    expect(result).toEqual({ ok: false, reason: "OLD_BOX_REQUIRED", state });
    expect(result.state).toBe(state);
  });

  it("selects an old box as context and opens one frozen, already-identified new box", () => {
    const state = opened();
    expect(state).toMatchObject({
      phase: "scanning",
      ownerDeviceId: OWNER,
      capacity: 20,
      activeProductionDate: "2026-08-19",
      oldSsccContext: OLD_SSCC,
      box: {
        newSscc: NEW_SSCC,
        productionDate: "2026-08-19",
        items: [],
      },
    });
  });

  it("journals every observation but admits only eligible items to membership", () => {
    for (const classification of [
      "protected",
      "known-ineligible",
      "unknown",
      "invalid",
      "duplicate",
    ] as const) {
      const state = opened();
      const result = reduceInventoryRepacking(state, {
        ...eligible(1),
        item: { ...eligible(1).item, classification },
      });
      expect(result).toMatchObject({
        ok: true,
        effect: { kind: "observation-only", classification },
        state: { box: { items: [] } },
      });
    }
  });

  it("keeps source-parent mismatch visible without rewriting immutable membership", () => {
    const result = reduceInventoryRepacking(opened(), {
      ...eligible(1),
      item: { ...eligible(1).item, sourceParentSscc: "046006820000000017" },
    });
    expect(result).toMatchObject({
      ok: true,
      effect: { kind: "item-added", sourceParentMismatch: true, position: 1 },
      state: { box: { items: [{ sourceParentMismatch: true }] } },
    });
  });

  it("makes duplicate active membership idempotent and does not consume another position", () => {
    const first = reduceInventoryRepacking(opened(), eligible(1));
    if (!first.ok) throw new Error(first.reason);
    const duplicate = reduceInventoryRepacking(first.state, {
      ...eligible(2),
      item: { ...eligible(2).item, codeHash: eligible(1).item.codeHash },
    });
    expect(duplicate).toMatchObject({
      ok: true,
      effect: { kind: "membership-replay", position: 1 },
      state: { box: { items: [{ codeHash: eligible(1).item.codeHash }] } },
    });
  });

  it("uses exactly twenty positions and auto-closes on the twentieth accepted item", () => {
    let state = opened(20);
    for (let position = 1; position <= 20; position += 1) {
      const result = reduceInventoryRepacking(state, eligible(position));
      if (!result.ok) throw new Error(result.reason);
      state = result.state;
      expect(state.box?.items).toHaveLength(position);
      if (position < 20) expect(state.phase).toBe("scanning");
      else {
        expect(state.phase).toBe("closed-pending-print");
        expect(result.effect).toMatchObject({ kind: "capacity-closed", position: 20 });
      }
    }
    const blocked = reduceInventoryRepacking(state, eligible(21));
    expect(blocked).toMatchObject({ ok: false, reason: "PRINT_PENDING" });
  });

  it("changes an empty box date in place but requires close or clear for a non-empty box", () => {
    const emptyChanged = reduceInventoryRepacking(opened(), {
      type: "change-active-date",
      deviceId: OWNER,
      productionDate: "2026-08-20",
    });
    expect(emptyChanged).toMatchObject({
      ok: true,
      state: {
        activeProductionDate: "2026-08-20",
        box: { productionDate: "2026-08-20", items: [] },
      },
    });
    if (!emptyChanged.ok) throw new Error(emptyChanged.reason);
    const added = reduceInventoryRepacking(emptyChanged.state, eligible(1, "2026-08-20"));
    if (!added.ok) throw new Error(added.reason);
    const blocked = reduceInventoryRepacking(added.state, {
      type: "change-active-date",
      deviceId: OWNER,
      productionDate: "2026-08-21",
    });
    expect(blocked).toMatchObject({ ok: false, reason: "NON_EMPTY_BOX_DATE_FROZEN" });
  });

  it("rejects a differently dated item from membership without changing its observation", () => {
    const result = reduceInventoryRepacking(opened(), eligible(1, "2026-08-20"));
    expect(result).toMatchObject({
      ok: true,
      effect: {
        kind: "observation-only",
        classification: "eligible",
        reason: "BOX_DATE_MISMATCH",
      },
      state: { box: { items: [] } },
    });
  });

  it("requires explicit confirmation before an incomplete close", () => {
    const first = reduceInventoryRepacking(opened(), eligible(1));
    if (!first.ok) throw new Error(first.reason);
    const prompt = reduceInventoryRepacking(first.state, {
      type: "close-incomplete",
      deviceId: OWNER,
      confirmed: false,
      closedAt: "2026-08-25T11:00:00.000Z",
    });
    expect(prompt).toEqual({ ok: false, reason: "CONFIRM_INCOMPLETE_CLOSE", state: first.state });
    const closed = reduceInventoryRepacking(first.state, {
      type: "close-incomplete",
      deviceId: OWNER,
      confirmed: true,
      closedAt: "2026-08-25T11:00:00.000Z",
    });
    expect(closed).toMatchObject({
      ok: true,
      effect: { kind: "incomplete-closed" },
      state: { phase: "closed-pending-print", box: { items: [{ position: 1 }] } },
    });
  });

  it("removes only the last membership and clears without replacing the reserved SSCC", () => {
    const first = reduceInventoryRepacking(opened(), eligible(1));
    if (!first.ok) throw new Error(first.reason);
    const second = reduceInventoryRepacking(first.state, eligible(2));
    if (!second.ok) throw new Error(second.reason);
    const removed = reduceInventoryRepacking(second.state, {
      type: "remove-last",
      deviceId: OWNER,
      removedAt: "2026-08-25T11:00:00.000Z",
    });
    expect(removed).toMatchObject({ ok: true, state: { box: { newSscc: NEW_SSCC, items: [{}] } } });
    if (!removed.ok) throw new Error(removed.reason);
    const cleared = reduceInventoryRepacking(removed.state, {
      type: "clear-open-box",
      deviceId: OWNER,
      clearedAt: "2026-08-25T11:01:00.000Z",
    });
    expect(cleared).toMatchObject({
      ok: true,
      effect: { kind: "box-cleared", removedCount: 1 },
      state: { phase: "scanning", box: { newSscc: NEW_SSCC, items: [] } },
    });
  });

  it("denies every foreign-terminal mutation and explicitly invalidates a losing box", () => {
    const state = opened();
    for (const action of [
      { ...eligible(1), deviceId: FOREIGN },
      { type: "remove-last" as const, deviceId: FOREIGN, removedAt: "2026-08-25T11:00:00Z" },
      { type: "clear-open-box" as const, deviceId: FOREIGN, clearedAt: "2026-08-25T11:00:00Z" },
      {
        type: "close-incomplete" as const,
        deviceId: FOREIGN,
        confirmed: true,
        closedAt: "2026-08-25T11:00:00Z",
      },
    ]) {
      const result = reduceInventoryRepacking(state, action);
      expect(result).toMatchObject({ ok: false, reason: "FOREIGN_BOX_OWNER" });
      expect(result.state).toBe(state);
    }
    const invalidated = reduceInventoryRepacking(state, {
      type: "authoritative-conflict",
      affectedBoxIds: [state.box!.boxId],
      invalidatedAt: "2026-08-25T11:02:00.000Z",
    });
    expect(invalidated).toMatchObject({
      ok: true,
      effect: { kind: "box-invalidated" },
      state: { phase: "invalidated" },
    });
  });
});
