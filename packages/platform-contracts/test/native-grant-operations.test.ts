import { describe, expect, it } from "vitest";
import { ENTITLEMENT_OPERATIONS, nativeGrantOperationIds } from "../src/entitlements.js";
describe("native grant operation authority", () => {
  it("maps native producers and rejects incompatible device capabilities", () => {
    expect(nativeGrantOperationIds("station", "shift.start.v1")).toEqual(["native.shift.start.v1"]);
    expect(nativeGrantOperationIds("handheld", "inventory.start.v1")).toEqual([
      "native.inventory.start.v1",
      "handheld.work.start.v1",
    ]);
    expect(nativeGrantOperationIds("kiosk", "pickup.start.v1")).toEqual(["native.pickup.start.v1"]);
    expect(nativeGrantOperationIds("station", "pickup.start.v1")).toBeNull();
    expect(nativeGrantOperationIds("kiosk", "shift.start.v1")).toBeNull();
  });
  it("declares separate native operations without public or cabinet authority", () => {
    expect(ENTITLEMENT_OPERATIONS).toMatchObject({
      "native.shift.start.v1": { authorization: "station_device", features: [], class: "new_work" },
      "native.inventory.start.v1": {
        authorization: "station_device",
        features: ["inventory"],
        class: "new_work",
      },
      "native.pickup.start.v1": { authorization: "kiosk_device", features: [], class: "new_work" },
    });
  });
});
