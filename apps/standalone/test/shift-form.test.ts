import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { shiftCreate, shiftUpdate } from "../src/host/requests.js";
import {
  SHIFT_CONFLICTS,
  SHIFT_FIELD_ORDER,
  SHIFT_FIELDS,
  shiftFields,
  shiftFieldsSchema,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
} from "../src/office/shifts/shift-form.js";
import { ACTIVE, PALLET, PLANNED } from "./support/shifts.js";

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
      palletsEnabled: false,
      palletBoxCapacity: "",
      palletTemplateId: "",
      palletSheetTemplateId: "",
      counterpartyId: ACTIVE.counterpartyId,
    });
    const withPallets = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    expect(shiftFields(withPallets)).toMatchObject({
      palletsEnabled: true,
      palletBoxCapacity: "40",
      palletTemplateId: PALLET.id,
    });
    for (const shift of [ACTIVE, PLANNED, withPallets]) {
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
      pallets: null,
    });
    expect(
      toShiftInput({
        ...shiftFields(PLANNED),
        palletsEnabled: true,
        palletBoxCapacity: " 32 ",
        palletTemplateId: PALLET.id,
      }).pallets,
    ).toEqual({ boxCapacity: 32, templateId: PALLET.id, sheetId: null });
    // Pallets turned off send none, whatever their fields still hold.
    expect(
      toShiftInput({
        ...shiftFields(PLANNED),
        palletsEnabled: false,
        palletBoxCapacity: "32",
        palletTemplateId: PALLET.id,
      }).pallets,
    ).toBeNull();
    // The change of a planned shift never names its product.
    expect(Object.keys(toShiftChange(shiftFields(PLANNED)))).not.toContain("productId");
  });

  it("requires the pallets' capacity and template only when the shift has pallets (plan О-Ф)", () => {
    const fields = { ...shiftFields(PLANNED), palletBoxCapacity: "", palletTemplateId: "" };
    expect(shiftFieldsSchema.safeParse(fields).success).toBe(true);
    const refused = shiftFieldsSchema.safeParse({ ...fields, palletsEnabled: true });
    expect(refused.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["palletBoxCapacity", "rules.shiftPalletBoxCapacity"],
      ["palletTemplateId", "office.shifts.errors.palletTemplateRequired"],
    ]);
    for (const capacity of ["0", "10001", "1.5", "сорок"]) {
      expect(
        shiftFieldsSchema.safeParse({
          ...fields,
          palletsEnabled: true,
          palletBoxCapacity: capacity,
          palletTemplateId: PALLET.id,
        }).success,
      ).toBe(false);
    }
    for (const capacity of ["1", " 10000 "]) {
      expect(
        shiftFieldsSchema.safeParse({
          ...fields,
          palletsEnabled: true,
          palletBoxCapacity: capacity,
          palletTemplateId: PALLET.id,
        }).success,
      ).toBe(true);
    }
  });

  it("puts a refused pallet template under its select and a refused pallet capacity under its field", () => {
    expect(sort(api("validation_failed", { field: "palletTemplateId" }))).toEqual({
      failure: {
        kind: "field",
        field: "palletTemplateId",
        message: "office.shifts.errors.palletTemplateRejected",
      },
      outdated: false,
    });
    expect(sort(api("validation_failed", { field: "palletBoxCapacity" }))).toEqual({
      failure: { kind: "field", field: "palletBoxCapacity", message: "rules.rejected" },
      outdated: false,
    });
  });

  it("carries a shift's A4 sheet: the form holds it, an empty choice is the main sheet, a chosen one goes with the pallets (plan А4)", () => {
    const SHEET = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a50";
    const withSheet = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
      palletSheetTemplateId: SHEET,
    };
    expect(shiftFields(withSheet).palletSheetTemplateId).toBe(SHEET);
    expect(shiftFields(PLANNED).palletSheetTemplateId).toBe("");
    const pallets = { ...shiftFields(withSheet), palletsEnabled: true };
    expect(toShiftInput(pallets).pallets).toEqual({
      boxCapacity: 40,
      templateId: PALLET.id,
      sheetId: SHEET,
    });
    // «Основной лист организации» is the main sheet (`null`), never an empty id.
    const main = toShiftInput({ ...pallets, palletSheetTemplateId: "" }).pallets;
    expect(main).toEqual({ boxCapacity: 40, templateId: PALLET.id, sheetId: null });
    // A new shift sends no sheet for it: the host gives it the main one.
    const created = shiftCreate(toShiftInput({ ...pallets, palletSheetTemplateId: "" }));
    expect(created).not.toHaveProperty("palletSheetTemplateId");
    // A planned shift that holds a sheet goes back to the main one with `null`...
    expect(
      shiftUpdate(
        withSheet,
        toShiftChange({ ...shiftFields(withSheet), palletSheetTemplateId: "" }),
      ),
    ).toStrictEqual({ palletSheetTemplateId: null, expectedRev: withSheet.rev });
    // ... and one with pallets but no sheet of its own sends nothing for it.
    const bare = { ...withSheet, palletSheetTemplateId: null };
    expect(shiftUpdate(bare, toShiftChange(shiftFields(bare)))).toStrictEqual({
      expectedRev: bare.rev,
    });
    // Pallets off send no sheet, whatever the field still holds.
    expect(toShiftInput({ ...pallets, palletsEnabled: false }).pallets).toBeNull();
    // An unchanged form of a shift with a sheet sends nothing back.
    expect(shiftUpdate(withSheet, toShiftChange(shiftFields(withSheet)))).toStrictEqual({
      expectedRev: withSheet.rev,
    });
    // The sheet needs no check of the form: the host decides.
    expect(shiftFieldsSchema.safeParse({ ...pallets, palletSheetTemplateId: "" }).success).toBe(
      true,
    );
    expect(SHIFT_FIELD_ORDER.indexOf("palletSheetTemplateId")).toBe(
      SHIFT_FIELD_ORDER.indexOf("palletTemplateId") + 1,
    );
  });

  it("puts a refused A4 sheet under its select (plan А4)", () => {
    expect(sort(api("validation_failed", { field: "palletSheetTemplateId" }))).toEqual({
      failure: {
        kind: "field",
        field: "palletSheetTemplateId",
        message: "office.shifts.errors.palletSheetRejected",
      },
      outdated: false,
    });
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
