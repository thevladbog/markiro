import { readFileSync } from "node:fs";
import { GRANT_EVENT_DIMENSIONS } from "../src/offline-grants/budgets.js";
import type { GrantEventType } from "../src/offline-grants/types.js";
import { describe, expect, it } from "vitest";
import { grantEventBudget, grantEventCost } from "../src/offline-grants/budgets.js";
describe("trusted productive grant dimensions", () => {
  it("matches the shared Kotlin producer fixture byte for byte", () => {
    const raw = readFileSync(
      new URL("../../platform-contracts/fixtures/offline-grant-budgets-v1.json", import.meta.url),
      "utf8",
    );
    expect(
      readFileSync(
        new URL(
          "../../../apps/handheld/app/src/test/resources/offline-grant-budgets-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).toBe(raw);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      events: (Object.keys(GRANT_EVENT_DIMENSIONS) as GrantEventType[]).map((event) => ({
        event,
        budget: grantEventBudget(event, { maxEvents: 5, maxUnits: 7, maxContainers: 3 }),
        cost: grantEventCost(event, { units: 2, containers: 1 }),
      })),
    });
  });
  it("requires units for scan and preserves exhausted zero ceilings", () => {
    expect(grantEventBudget("shift.scan.v1", { maxEvents: 1 })).toBeNull();
    expect(grantEventBudget("shift.scan.v1", { maxEvents: 0, maxUnits: 0 })).toEqual([
      { id: "shift.scan.v1:events", unit: "event", maximum: 0 },
      { id: "shift.scan.v1:units", unit: "unit", maximum: 0 },
    ]);
  });
  it("counts every pickup dimension and never accepts a caller override of event cost", () => {
    expect(grantEventCost("pickup.complete.v1", { units: 3, containers: 1 })).toEqual({
      "pickup.complete.v1:events": 1,
      "pickup.complete.v1:units": 3,
      "pickup.complete.v1:containers": 1,
    });
    expect(grantEventCost("pickup.complete.v1", { units: 3 })).toBeNull();
    expect(grantEventCost("inventory.scan.v1", { units: -1 })).toBeNull();
  });
  it("bounds completion events even when they add no units", () => {
    expect(grantEventBudget("shift.close.v1", { maxEvents: 1 })).toEqual([
      { id: "shift.close.v1:events", unit: "event", maximum: 1 },
    ]);
    expect(grantEventCost("shift.close.v1", {})).toEqual({ "shift.close.v1:events": 1 });
  });
});
