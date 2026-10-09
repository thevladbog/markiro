import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { shiftUpdate } from "../src/host/requests.js";
import {
  SHIFT_CONFLICTS,
  SHIFT_FIELDS,
  shiftFields,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
} from "../src/office/shifts/shift-form.js";
import { ACTIVE, PLANNED } from "./support/shifts.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

const sort = (error: unknown) => shiftWriteFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS);

describe("a shift's form", () => {
  it("loads a planned shift's own values, and sends nothing back for them", () => {
    expect(shiftFields(ACTIVE)).toEqual({
      productId: ACTIVE.productId,
      lineId: ACTIVE.lineId,
      productionDate: "2026-10-08",
      plannedQty: "1200",
      boxCapacity: "12",
      boxTemplateId: ACTIVE.boxTemplateId,
      counterpartyId: ACTIVE.counterpartyId,
    });
    for (const shift of [ACTIVE, PLANNED]) {
      expect(shiftUpdate(shift, toShiftChange(shiftFields(shift)))).toStrictEqual({
        expectedRev: shift.rev,
      });
    }
  });

  it("turns the form's text into the host's numbers and nulls, trimmed", () => {
    expect(
      toShiftInput({
        ...shiftFields(PLANNED),
        plannedQty: " 900 ",
        boxCapacity: " 20 ",
      }),
    ).toEqual({
      productId: PLANNED.productId,
      lineId: PLANNED.lineId,
      productionDate: "2026-10-09",
      boxTemplateId: PLANNED.boxTemplateId,
      boxCapacity: 20,
      plannedQty: 900,
      counterpartyId: null,
    });
    // The change of a planned shift never names its product.
    expect(Object.keys(toShiftChange(shiftFields(PLANNED)))).not.toContain("productId");
  });

  it("calls a shift deleted meanwhile, or opened or closed meanwhile, outdated in words of its own", () => {
    expect(sort(api("not_found"))).toEqual({
      failure: { kind: "alert", message: "office.shifts.errors.gone" },
      outdated: true,
    });
    for (const [status, message] of [
      ["active", "office.shifts.errors.nowActive"],
      ["closed", "office.shifts.errors.nowClosed"],
      ["planned", "office.shifts.errors.notOpen"],
    ] as const) {
      expect(sort(api("conflict", { constraint: "shift_status", status }))).toEqual({
        failure: { kind: "alert", message },
        outdated: true,
      });
    }
  });

  it("sorts the rest as any office write: a record under its select, a stale write, an alert", () => {
    expect(sort(api("conflict", { constraint: "product_inactive" }))).toEqual({
      failure: {
        kind: "field",
        field: "productId",
        message: "office.shifts.errors.productInactive",
      },
      outdated: false,
    });
    expect(sort(api("validation_failed", { field: "lineId" }))).toEqual({
      failure: { kind: "field", field: "lineId", message: "office.shifts.errors.lineRejected" },
      outdated: false,
    });
    expect(sort(api("validation_failed", { field: "boxCapacity" }))).toEqual({
      failure: { kind: "field", field: "boxCapacity", message: "rules.rejected" },
      outdated: false,
    });
    expect(sort(api("stale_revision"))).toEqual({ failure: { kind: "stale" }, outdated: false });
    expect(sort(api("conflict", { constraint: "shift_busy" }))).toEqual({
      failure: { kind: "alert", message: "errors.api.conflict" },
      outdated: false,
    });
    expect(sort(new HostError({ kind: "transport", code: "unreachable", message: "x" }))).toEqual({
      failure: { kind: "alert", message: "errors.transport.unreachable" },
      outdated: false,
    });
  });
});
