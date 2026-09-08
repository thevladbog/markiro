import { z } from "zod";
import {
  assertDuplicateTemplate,
  DomainError,
  validationPrintPolicySchema,
  type EnabledValidationPrintPolicy,
} from "@markiro/domain";
import type { SqlExecutor, StationBundle } from "../mirror.js";
import { duplicateLabelContextSchema } from "./fields.js";

const labelContextSchema = duplicateLabelContextSchema.omit({ operatorName: true });
const mirroredContextSchema = z
  .strictObject({
    policy: validationPrintPolicySchema,
    labelContext: labelContextSchema.nullable(),
  })
  .refine((value) => (value.policy.mode === "none") === (value.labelContext === null));
export type MirroredProductLabelContext = z.infer<typeof mirroredContextSchema>;
export interface DuplicateLabelContext {
  policy: EnabledValidationPrintPolicy;
  labelContext: z.infer<typeof labelContextSchema>;
}

function invalidContext(): never {
  throw new DomainError(
    "PRODUCT_LABEL_CONTEXT_INVALID",
    "Duplicate label context is missing or inconsistent",
  );
}

export function parseMirroredProductLabelContext(
  raw: string | null | undefined,
): MirroredProductLabelContext | null {
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidContext();
  }
  const result = mirroredContextSchema.safeParse(value);
  if (!result.success) invalidContext();
  if (result.data.policy.mode === "duplicate_dm")
    assertDuplicateTemplate(result.data.policy.snapshot.spec);
  return result.data;
}

/** The complete printing context is published with the shift, before the separate catalog mirror. */
export function productLabelContextForBundle(
  bundle: StationBundle,
): MirroredProductLabelContext | null {
  const { shift, product } = bundle;
  if (shift.validationPrint === undefined) return null;
  const result = validationPrintPolicySchema.safeParse(shift.validationPrint);
  if (!result.success) invalidContext();
  const policy = result.data;
  if (policy.mode === "none") return { policy, labelContext: null };
  if (
    shift.mode !== "validation" ||
    shift.productId !== product.id ||
    !["planned", "active", "closed"].includes(shift.status)
  )
    invalidContext();
  assertDuplicateTemplate(policy.snapshot.spec);
  const context = labelContextSchema.safeParse({
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: product.egaisCode,
    shelfLifeDays: product.shelfLifeDays,
    counterpartyName: shift.counterpartyName,
    productionDate: shift.productionDate,
    shiftNumber: shift.number,
  });
  if (!context.success) invalidContext();
  return { policy, labelContext: context.data };
}

export async function readDuplicateLabelContext(
  exec: SqlExecutor,
  shiftId: string,
): Promise<DuplicateLabelContext | null> {
  const [row] = await exec.all<{ validation_print_context: string | null }>(
    "SELECT validation_print_context FROM shift_mirror WHERE id = ?",
    [shiftId],
  );
  const context = parseMirroredProductLabelContext(row?.validation_print_context);
  if (!context || context.policy.mode !== "duplicate_dm") return null;
  if (context.labelContext === null) invalidContext();
  return { policy: context.policy, labelContext: context.labelContext };
}
