import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { shiftCreate, shiftUpdate } from "../src/host/requests.js";
import {
  newShiftFields,
  SHIFT_CONFLICTS,
  SHIFT_FIELD_ORDER,
  SHIFT_FIELDS,
  shiftFields,
  shiftFieldsSchema,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
} from "../src/office/shifts/shift-form.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { ACTIVE, DUPLICATE_58, MILK_DUPLICATE, PALLET, PLANNED } from "./support/shifts.js";

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
      plannedDate: "2026-10-08",
      plannedQty: "1200",
      boxCapacity: "12",
      boxTemplateId: ACTIVE.boxTemplateId,
      palletsEnabled: false,
      palletBoxCapacity: "",
      palletTemplateId: "",
      palletSheetTemplateId: "",
      counterpartyId: ACTIVE.counterpartyId,
      mode: "aggregation",
      printDuplicate: false,
      duplicateTemplateId: "",
      verificationRequired: false,
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
      plannedDate: "2026-10-10",
      boxTemplateId: PLANNED.boxTemplateId,
      boxCapacity: 20,
      plannedQty: 900,
      counterpartyId: null,
      pallets: null,
      mode: "aggregation",
      validationPrint: { mode: "none" },
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

  it("starts a new shift as aggregation, and takes a planned shift's own mode (plan РЕЖ)", () => {
    expect(newShiftFields("2026-10-09").mode).toBe("aggregation");
    expect(shiftFields({ ...PLANNED, mode: "validation" }).mode).toBe("validation");
    expect(SHIFT_FIELD_ORDER.indexOf("mode")).toBe(SHIFT_FIELD_ORDER.indexOf("productId") + 1);
    expect(shiftFieldsSchema.safeParse({ ...shiftFields(PLANNED), mode: "manual" }).success).toBe(
      false,
    );
  });

  it("sends a validation shift without pallets and without checking its hidden counts (plan РЕЖ, Р4)", () => {
    const validation = {
      ...shiftFields(PLANNED),
      mode: "validation" as const,
      // What the hidden pallet fields still hold, from an aggregation chosen before.
      palletsEnabled: true,
      palletBoxCapacity: "сорок",
      palletTemplateId: "",
    };
    expect(shiftFieldsSchema.safeParse(validation).success).toBe(true);
    const input = toShiftInput(validation);
    expect(input).toMatchObject({ mode: "validation", pallets: null, boxCapacity: 24 });
    expect(shiftCreate(input)).toStrictEqual({
      productId: PLANNED.productId,
      lineId: PLANNED.lineId,
      productionDate: "2026-10-09",
      plannedDate: "2026-10-10",
      boxTemplateId: PLANNED.boxTemplateId,
      boxCapacity: 24,
      plannedQty: null,
      counterpartyId: null,
      mode: "validation",
      palletsEnabled: false,
      validationPrint: { mode: "none" },
    });
    // The box capacity is hidden too: one the rule refuses is not checked and not sent,
    // so the host keeps the product's on a create and the shift's own on a change.
    for (const capacity of ["", "0", "сорок"]) {
      const hidden = { ...validation, boxCapacity: capacity };
      expect(shiftFieldsSchema.safeParse(hidden).success).toBe(true);
      expect(toShiftInput(hidden)).not.toHaveProperty("boxCapacity");
      expect(shiftCreate(toShiftInput(hidden))).not.toHaveProperty("boxCapacity");
      expect(toShiftChange(hidden)).not.toHaveProperty("boxCapacity");
    }
    // Aggregation checks both, and reports them with the other refused fields.
    const refused = shiftFieldsSchema.safeParse({
      ...validation,
      mode: "aggregation",
      productId: "",
      boxCapacity: "0",
    });
    expect(refused.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "productId",
      "boxCapacity",
      "palletBoxCapacity",
      "palletTemplateId",
    ]);
  });

  it("sends a mode only when it changed (plan РЕЖ)", () => {
    expect(
      shiftUpdate(PLANNED, toShiftChange({ ...shiftFields(PLANNED), mode: "validation" })),
    ).toStrictEqual({ mode: "validation", expectedRev: PLANNED.rev });
    const validation = { ...PLANNED, mode: "validation" as const };
    expect(shiftUpdate(validation, toShiftChange(shiftFields(validation)))).toStrictEqual({
      expectedRev: validation.rev,
    });
    expect(
      shiftUpdate(validation, toShiftChange({ ...shiftFields(validation), mode: "aggregation" })),
    ).toStrictEqual({ mode: "aggregation", expectedRev: validation.rev });
    // A planned aggregation with pallets that becomes a validation turns its pallets off.
    const withPallets = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    expect(
      shiftUpdate(withPallets, toShiftChange({ ...shiftFields(withPallets), mode: "validation" })),
    ).toStrictEqual({ mode: "validation", palletsEnabled: false, expectedRev: withPallets.rev });
  });

  describe("the duplicate print under «Проверка» (plan РЕЖ part B, Р16)", () => {
    const validation = { ...shiftFields(PLANNED), mode: "validation" as const };
    const printing = {
      ...validation,
      printDuplicate: true,
      duplicateTemplateId: DUPLICATE_58.id,
    };
    /** A planned validation shift that prints with `verification`. */
    const printingShift = (verification: "none" | "required"): OfficeShift => ({
      ...PLANNED,
      mode: "validation",
      validationPrint: { mode: "duplicate_dm", templateId: DUPLICATE_58.id, verification },
    });

    it("starts with the flag off, no template and the check not required (the owner's default)", () => {
      expect(newShiftFields("2026-10-09")).toMatchObject({
        printDuplicate: false,
        duplicateTemplateId: "",
        verificationRequired: false,
      });
      expect(shiftFields(PLANNED)).toMatchObject({
        printDuplicate: false,
        duplicateTemplateId: "",
        verificationRequired: false,
      });
    });

    it("takes a planned shift's own policy back into the three fields", () => {
      expect(shiftFields(printingShift("required"))).toMatchObject({
        mode: "validation",
        printDuplicate: true,
        duplicateTemplateId: DUPLICATE_58.id,
        verificationRequired: true,
      });
      expect(shiftFields(printingShift("none"))).toMatchObject({
        printDuplicate: true,
        duplicateTemplateId: DUPLICATE_58.id,
        verificationRequired: false,
      });
      // A host before protocol 5 sends no policy: none.
      expect(
        shiftFields({ ...PLANNED, mode: "validation", validationPrint: { mode: "none" } }),
      ).toMatchObject({ printDuplicate: false, duplicateTemplateId: "" });
    });

    it("requires the template only for «Проверка» with the flag on", () => {
      expect(shiftFieldsSchema.safeParse(validation).success).toBe(true);
      const refused = shiftFieldsSchema.safeParse({ ...printing, duplicateTemplateId: "" });
      expect(refused.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["duplicateTemplateId", "office.shifts.duplicate.templateRequired"],
      ]);
      expect(shiftFieldsSchema.safeParse(printing).success).toBe(true);
      // Aggregation ignores whatever the hidden flag holds.
      expect(
        shiftFieldsSchema.safeParse({
          ...printing,
          mode: "aggregation",
          duplicateTemplateId: "",
        }).success,
      ).toBe(true);
    });

    it("orders the fields as the dialog shows them (Р16): the first refused takes the focus", () => {
      expect(SHIFT_FIELD_ORDER).toEqual([
        "productId",
        "mode",
        "printDuplicate",
        "productionDate",
        "plannedDate",
        "plannedQty",
        "lineId",
        "counterpartyId",
        "duplicateTemplateId",
        "verificationRequired",
        "boxTemplateId",
        "boxCapacity",
        "palletsEnabled",
        "palletBoxCapacity",
        "palletTemplateId",
        "palletSheetTemplateId",
      ]);
    });

    it("sends the policy of each state: none for aggregation and for «Проверка» without the flag, the template and the check with it", () => {
      expect(
        toShiftInput({ ...printing, mode: "aggregation", verificationRequired: true })
          .validationPrint,
      ).toEqual({ mode: "none" });
      expect(toShiftInput(validation).validationPrint).toEqual({ mode: "none" });
      expect(
        toShiftInput({
          ...validation,
          duplicateTemplateId: DUPLICATE_58.id,
          verificationRequired: true,
        }).validationPrint,
      ).toEqual({ mode: "none" });
      expect(toShiftInput(printing).validationPrint).toEqual({
        mode: "duplicate_dm",
        templateId: DUPLICATE_58.id,
        verification: "none",
      });
      expect(toShiftInput({ ...printing, verificationRequired: true }).validationPrint).toEqual({
        mode: "duplicate_dm",
        templateId: DUPLICATE_58.id,
        verification: "required",
      });
      // The create carries it as the shared fixture does.
      expect(shiftCreate(toShiftInput(printing))).toMatchObject({
        mode: "validation",
        validationPrint: {
          mode: "duplicate_dm",
          templateId: DUPLICATE_58.id,
          verification: "none",
        },
      });
    });

    it("sends the policy of a planned shift only when it changed", () => {
      // Turned on.
      expect(
        shiftUpdate(PLANNED, toShiftChange({ ...printing, mode: "validation" })),
      ).toStrictEqual({
        mode: "validation",
        validationPrint: {
          mode: "duplicate_dm",
          templateId: DUPLICATE_58.id,
          verification: "none",
        },
        expectedRev: PLANNED.rev,
      });
      const shift = printingShift("none");
      // Unchanged: nothing.
      expect(shiftUpdate(shift, toShiftChange(shiftFields(shift)))).toStrictEqual({
        expectedRev: shift.rev,
      });
      // Another template, the check required, the flag off: each alone.
      expect(
        shiftUpdate(
          shift,
          toShiftChange({ ...shiftFields(shift), duplicateTemplateId: MILK_DUPLICATE.id }),
        ),
      ).toStrictEqual({
        validationPrint: {
          mode: "duplicate_dm",
          templateId: MILK_DUPLICATE.id,
          verification: "none",
        },
        expectedRev: shift.rev,
      });
      expect(
        shiftUpdate(shift, toShiftChange({ ...shiftFields(shift), verificationRequired: true })),
      ).toStrictEqual({
        validationPrint: {
          mode: "duplicate_dm",
          templateId: DUPLICATE_58.id,
          verification: "required",
        },
        expectedRev: shift.rev,
      });
      expect(
        shiftUpdate(
          shift,
          toShiftChange({ ...shiftFields(shift), printDuplicate: false, duplicateTemplateId: "" }),
        ),
      ).toStrictEqual({ validationPrint: { mode: "none" }, expectedRev: shift.rev });
      // A printing shift turned into an aggregation says `none` in the same request (the host
      // refuses the mode alone).
      expect(
        shiftUpdate(shift, toShiftChange({ ...shiftFields(shift), mode: "aggregation" })),
      ).toStrictEqual({
        mode: "aggregation",
        validationPrint: { mode: "none" },
        expectedRev: shift.rev,
      });
      // A validation shift without print that becomes an aggregation sends the mode alone.
      const plain = { ...PLANNED, mode: "validation" as const };
      expect(
        shiftUpdate(plain, toShiftChange({ ...shiftFields(plain), mode: "aggregation" })),
      ).toStrictEqual({ mode: "aggregation", expectedRev: plain.rev });
    });

    it("never sends the policy of a shift that is no longer planned", () => {
      const active = { ...printingShift("none"), status: "active" as const };
      const change = toShiftChange(
        { ...shiftFields(active), verificationRequired: true },
        active.status,
      );
      expect(change).not.toHaveProperty("validationPrint");
      expect(shiftUpdate(active, change)).toStrictEqual({ expectedRev: active.rev });
      expect(
        toShiftChange({ ...shiftFields(active), verificationRequired: true }, "planned"),
      ).toHaveProperty("validationPrint");
    });

    it("puts a refused duplicate template under its select", () => {
      expect(sort(api("validation_failed", { field: "validationPrint.templateId" }))).toEqual({
        failure: {
          kind: "field",
          field: "duplicateTemplateId",
          message: "office.shifts.errors.duplicateTemplateRejected",
        },
        outdated: false,
      });
    });
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
