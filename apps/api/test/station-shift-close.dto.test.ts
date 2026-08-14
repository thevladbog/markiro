import { describe, expect, it } from "vitest";
import { stationShiftCloseSchema } from "../src/modules/station-shift-close/dto";

const base = {
  eventId: "11111111-1111-4111-8111-111111111111",
  shiftId: "22222222-2222-4222-8222-222222222222",
  operatorId: null,
  plannedQtySnapshot: 10,
  actualQty: 10,
  closedBoxCount: 1,
  closedAt: "2026-08-14T12:00:00.000Z",
};

describe("station shift close payload", () => {
  it("does not require a reason when there is no plan or the plan matches", () => {
    expect(stationShiftCloseSchema.safeParse({ ...base, plannedQtySnapshot: null }).success).toBe(true);
    expect(stationShiftCloseSchema.safeParse(base).success).toBe(true);
  });

  it("requires one of the fixed reasons for a plan mismatch", () => {
    expect(stationShiftCloseSchema.safeParse({ ...base, actualQty: 9 }).success).toBe(false);
    expect(
      stationShiftCloseSchema.safeParse({
        ...base,
        actualQty: 9,
        reasonCode: "equipment_stop",
      }).success,
    ).toBe(true);
    expect(
      stationShiftCloseSchema.safeParse({ ...base, actualQty: 9, reasonCode: "operator_note" }).success,
    ).toBe(false);
  });
});
