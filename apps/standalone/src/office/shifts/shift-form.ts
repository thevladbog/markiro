import { z } from "zod";

import { HostError } from "../../host/client.js";
import {
  shiftModeSchema,
  type OfficeShift,
  type ShiftStatus,
  type ValidationPrint,
} from "../../host/protocol.js";
import type { ShiftChange, ShiftInput } from "../../host/requests.js";
import {
  plannedQtyRule,
  productionDateRule,
  shiftBoxCapacityRule,
  shiftPalletBoxCapacityRule,
  toCount,
} from "../../lib/rules.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";

/**
 * A shift as the form holds it: the ids its selects hold (`""` for none), the
 * production date `YYYY-MM-DD`, the counts as typed, the mode and the
 * duplicate print (plan РЕЖ). With pallets (plan О-Ф) their capacity and
 * template are required; without, whatever the two fields still hold is
 * neither checked nor sent. A validation shift hides its box capacity and its
 * pallets (Р16): the form keeps what they hold, for an aggregation chosen
 * again, but checks none of it. «Печатать дубликат Data Matrix»
 * (`printDuplicate`, part B) is a validation shift's alone and needs its
 * template; the dialog clears the three print fields when «Агрегация» is
 * chosen (Р16), and the schema ignores them for an aggregation anyway.
 */
export const shiftFieldsSchema = z
  .object({
    productId: z.string().min(1, "office.shifts.errors.productRequired"),
    mode: shiftModeSchema,
    lineId: z.string().min(1, "office.shifts.errors.lineRequired"),
    productionDate: productionDateRule,
    plannedQty: plannedQtyRule,
    boxCapacity: z.string(),
    boxTemplateId: z.string().min(1, "office.shifts.errors.templateRequired"),
    palletsEnabled: z.boolean(),
    palletBoxCapacity: z.string(),
    palletTemplateId: z.string(),
    /** The A4 sheet; `""` is the organization's main sheet, which needs no check. */
    palletSheetTemplateId: z.string(),
    counterpartyId: z.string(),
    printDuplicate: z.boolean(),
    duplicateTemplateId: z.string(),
    verificationRequired: z.boolean(),
  })
  .superRefine((values, context) => {
    if (values.mode === "validation") {
      if (values.printDuplicate && values.duplicateTemplateId === "") {
        context.addIssue({
          code: "custom",
          path: ["duplicateTemplateId"],
          message: "office.shifts.duplicate.templateRequired",
        });
      }
      return;
    }
    if (!shiftBoxCapacityRule.safeParse(values.boxCapacity).success) {
      context.addIssue({
        code: "custom",
        path: ["boxCapacity"],
        message: "rules.shiftBoxCapacity",
      });
    }
    if (!values.palletsEnabled) return;
    const capacity = shiftPalletBoxCapacityRule.safeParse(values.palletBoxCapacity);
    if (!capacity.success) {
      context.addIssue({
        code: "custom",
        path: ["palletBoxCapacity"],
        message: "rules.shiftPalletBoxCapacity",
      });
    }
    if (values.palletTemplateId === "") {
      context.addIssue({
        code: "custom",
        path: ["palletTemplateId"],
        message: "office.shifts.errors.palletTemplateRequired",
      });
    }
  });
export type ShiftFields = z.input<typeof shiftFieldsSchema>;

/**
 * The fields in the order the form shows them, the cloud's (Р16): the product,
 * the mode and its print flag, the dates and the plan, the line and the
 * counterparty, «Печать дубликата», the box template, then the box capacity
 * and the pallets. The first one refused takes the focus.
 */
export const SHIFT_FIELD_ORDER = [
  "productId",
  "mode",
  "printDuplicate",
  "productionDate",
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
] as const satisfies readonly (keyof ShiftFields)[];

/** The form's values for a new shift on `today`, the organization's civil date. */
export function newShiftFields(today: string): ShiftFields {
  return {
    productId: "",
    mode: "aggregation",
    lineId: "",
    productionDate: today,
    plannedQty: "",
    boxCapacity: "",
    boxTemplateId: "",
    palletsEnabled: false,
    palletBoxCapacity: "",
    palletTemplateId: "",
    palletSheetTemplateId: "",
    counterpartyId: "",
    printDuplicate: false,
    duplicateTemplateId: "",
    // The owner's default (the cloud's is on).
    verificationRequired: false,
  };
}

/**
 * The form's values for a planned shift being changed: its own, the counts as
 * text, the print policy as the three fields (none when a host before
 * protocol 5 sends no policy).
 */
export function shiftFields(shift: OfficeShift): ShiftFields {
  const print = shift.validationPrint;
  const duplicate = print?.mode === "duplicate_dm" ? print : null;
  return {
    productId: shift.productId,
    mode: shift.mode,
    lineId: shift.lineId,
    productionDate: shift.productionDate,
    plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty),
    boxCapacity: String(shift.boxCapacity),
    boxTemplateId: shift.boxTemplateId,
    palletsEnabled: shift.palletsEnabled,
    palletBoxCapacity: shift.palletBoxCapacity === null ? "" : String(shift.palletBoxCapacity),
    palletTemplateId: shift.palletTemplateId ?? "",
    palletSheetTemplateId: shift.palletSheetTemplateId ?? "",
    counterpartyId: shift.counterpartyId ?? "",
    printDuplicate: duplicate !== null,
    duplicateTemplateId: duplicate?.templateId ?? "",
    verificationRequired: duplicate?.verification === "required",
  };
}

/**
 * The print policy the form holds (Р16, the cloud's `toPayload`): a duplicate
 * only for «Проверка» with the flag on, its template and whether its check is
 * required; `none` for everything else, whatever the hidden fields hold.
 */
export function toValidationPrint(values: ShiftFields): ValidationPrint {
  return values.mode === "validation" && values.printDuplicate
    ? {
        mode: "duplicate_dm",
        templateId: values.duplicateTemplateId,
        verification: values.verificationRequired ? "required" : "none",
      }
    : { mode: "none" };
}

/**
 * The host's fields for values the form accepted: the counts as numbers,
 * `null` for no plan, no counterparty or no pallets, and the mode. A
 * validation shift has no pallets; its box capacity, hidden, goes as the
 * form holds it (the product's, or the planned shift's own: the host keeps
 * the column, Р4) when it is a count the rule takes, and is left out
 * otherwise, so the host keeps the product's on a create and the shift's own
 * on a change. The print policy goes as `toValidationPrint` gives it, `none`
 * included, so the host's default never decides it.
 */
export function toShiftInput(values: ShiftFields): ShiftInput {
  const validation = values.mode === "validation";
  const boxCapacity =
    !validation || shiftBoxCapacityRule.safeParse(values.boxCapacity).success
      ? { boxCapacity: Number(values.boxCapacity.trim()) }
      : {};
  return {
    productId: values.productId,
    lineId: values.lineId,
    productionDate: values.productionDate,
    boxTemplateId: values.boxTemplateId,
    ...boxCapacity,
    plannedQty: toCount(values.plannedQty),
    counterpartyId: values.counterpartyId === "" ? null : values.counterpartyId,
    mode: values.mode,
    validationPrint: toValidationPrint(values),
    pallets:
      values.palletsEnabled && !validation
        ? {
            boxCapacity: Number(values.palletBoxCapacity.trim()),
            templateId: values.palletTemplateId,
            // «Основной лист организации» (`""`) is the main sheet, never an empty id.
            sheetId: values.palletSheetTemplateId === "" ? null : values.palletSheetTemplateId,
          }
        : null,
  };
}

/**
 * Where a refusal of a shift's write goes: a `validation_failed` on a record
 * goes under its select in words of its own (the record was archived, turned
 * off or narrowed while the form was open), one on a count or the date says
 * that the host did not take the value.
 */
export const SHIFT_FIELDS = {
  productId: { field: "productId", message: "office.shifts.errors.productRejected" },
  lineId: { field: "lineId", message: "office.shifts.errors.lineRejected" },
  boxTemplateId: { field: "boxTemplateId", message: "office.shifts.errors.templateRejected" },
  counterpartyId: { field: "counterpartyId", message: "office.shifts.errors.counterpartyRejected" },
  palletTemplateId: {
    field: "palletTemplateId",
    message: "office.shifts.errors.palletTemplateRejected",
  },
  palletSheetTemplateId: {
    field: "palletSheetTemplateId",
    message: "office.shifts.errors.palletSheetRejected",
  },
  "validationPrint.templateId": {
    field: "duplicateTemplateId",
    message: "office.shifts.errors.duplicateTemplateRejected",
  },
  productionDate: "productionDate",
  plannedQty: "plannedQty",
  boxCapacity: "boxCapacity",
  palletBoxCapacity: "palletBoxCapacity",
} as const;

/** A draft or archived product (`product_inactive`) goes under the product. */
export const SHIFT_CONFLICTS = {
  product_inactive: { field: "productId", message: "office.shifts.errors.productInactive" },
} as const;

/**
 * What a planned shift is to become, for `shiftUpdate`: every field the form
 * holds but the product, which never changes (`shiftUpdate` sends the mode
 * and the print policy, like the rest, only when they changed). The print
 * policy is a planned shift's only (`status`): an open one froze it, and the
 * host refuses a change of it (`conflict` on `shift_status`).
 */
export function toShiftChange(values: ShiftFields, status: ShiftStatus = "planned"): ShiftChange {
  const input = toShiftInput(values);
  return {
    lineId: input.lineId,
    productionDate: input.productionDate,
    boxTemplateId: input.boxTemplateId,
    ...(input.boxCapacity === undefined ? {} : { boxCapacity: input.boxCapacity }),
    plannedQty: input.plannedQty,
    counterpartyId: input.counterpartyId,
    pallets: input.pallets,
    mode: values.mode,
    ...(status === "planned" && input.validationPrint !== undefined
      ? { validationPrint: input.validationPrint }
      : {}),
  };
}

/**
 * Sorts a refused change of a shift: one a station opened or someone closed
 * meanwhile (`conflict` on `shift_status`, which names the status now) and one
 * deleted meanwhile (`not_found`) are alerts in words of their own, which the
 * page follows by reading the list again (`outdated`); the rest goes as
 * `writeFailure` sorts it with `fields` and `conflicts`.
 */
export function shiftWriteFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F | FieldMessage<F>>>,
  conflicts: Readonly<Record<string, FieldMessage<F>>> = {},
): { failure: WriteFailure<F>; outdated: boolean } {
  if (error instanceof HostError) {
    if (error.code === "not_found") {
      return { failure: { kind: "alert", message: "office.shifts.errors.gone" }, outdated: true };
    }
    if (error.code === "conflict" && error.details.constraint === "shift_status") {
      const status = error.details.status;
      const message =
        status === "active"
          ? "office.shifts.errors.nowActive"
          : status === "closed"
            ? "office.shifts.errors.nowClosed"
            : "office.shifts.errors.notOpen";
      return { failure: { kind: "alert", message }, outdated: true };
    }
  }
  return { failure: writeFailure(error, fields, conflicts), outdated: false };
}
