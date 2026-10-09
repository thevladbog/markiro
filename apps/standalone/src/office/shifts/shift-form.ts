import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import type { ShiftChange, ShiftInput } from "../../host/requests.js";
import {
  plannedQtyRule,
  productionDateRule,
  shiftBoxCapacityRule,
  toCount,
} from "../../lib/rules.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";

/**
 * A shift as the form holds it: the ids its selects hold (`""` for none), the
 * production date `YYYY-MM-DD` and the counts as typed.
 */
export const shiftFieldsSchema = z.object({
  productId: z.string().min(1, "office.shifts.errors.productRequired"),
  lineId: z.string().min(1, "office.shifts.errors.lineRequired"),
  productionDate: productionDateRule,
  plannedQty: plannedQtyRule,
  boxCapacity: shiftBoxCapacityRule,
  boxTemplateId: z.string().min(1, "office.shifts.errors.templateRequired"),
  counterpartyId: z.string(),
});
export type ShiftFields = z.input<typeof shiftFieldsSchema>;

/** The fields in the order the form shows them: the first one refused takes the focus. */
export const SHIFT_FIELD_ORDER = [
  "productId",
  "lineId",
  "productionDate",
  "plannedQty",
  "boxCapacity",
  "boxTemplateId",
  "counterpartyId",
] as const satisfies readonly (keyof ShiftFields)[];

/** The form's values for a new shift on `today`, the organization's civil date. */
export function newShiftFields(today: string): ShiftFields {
  return {
    productId: "",
    lineId: "",
    productionDate: today,
    plannedQty: "",
    boxCapacity: "",
    boxTemplateId: "",
    counterpartyId: "",
  };
}

/** The form's values for a planned shift being changed: its own, the counts as text. */
export function shiftFields(shift: OfficeShift): ShiftFields {
  return {
    productId: shift.productId,
    lineId: shift.lineId,
    productionDate: shift.productionDate,
    plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty),
    boxCapacity: String(shift.boxCapacity),
    boxTemplateId: shift.boxTemplateId,
    counterpartyId: shift.counterpartyId ?? "",
  };
}

/**
 * The host's fields for values the form accepted: the counts as numbers,
 * `null` for no plan or no counterparty.
 */
export function toShiftInput(values: ShiftFields): ShiftInput {
  return {
    productId: values.productId,
    lineId: values.lineId,
    productionDate: values.productionDate,
    boxTemplateId: values.boxTemplateId,
    boxCapacity: Number(values.boxCapacity.trim()),
    plannedQty: toCount(values.plannedQty),
    counterpartyId: values.counterpartyId === "" ? null : values.counterpartyId,
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
  productionDate: "productionDate",
  plannedQty: "plannedQty",
  boxCapacity: "boxCapacity",
} as const;

/** A draft or archived product (`product_inactive`) goes under the product. */
export const SHIFT_CONFLICTS = {
  product_inactive: { field: "productId", message: "office.shifts.errors.productInactive" },
} as const;

/**
 * What a planned shift is to become, for `shiftUpdate`: every field the form
 * holds but the product, which never changes.
 */
export function toShiftChange(values: ShiftFields): ShiftChange {
  const input = toShiftInput(values);
  return {
    lineId: input.lineId,
    productionDate: input.productionDate,
    boxTemplateId: input.boxTemplateId,
    boxCapacity: input.boxCapacity,
    plannedQty: input.plannedQty,
    counterpartyId: input.counterpartyId,
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
