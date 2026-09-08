import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  assertDuplicateTemplate,
  parseLabelTemplate,
  PRODUCT_LABEL_PROTOCOL,
  productLabelValueDigest,
  validationPrintPolicySchema,
  type ValidationPrintInput,
  type ValidationPrintPolicy,
} from "@markiro/domain";
import type { ShiftMode } from "./dto";

export const VALIDATION_DM_DUPLICATE_ENABLED = Symbol("VALIDATION_DM_DUPLICATE_ENABLED");
export type ValidationPrintStorage = Pick<
  typeof schema.shifts.$inferSelect,
  | "validationPrintMode"
  | "validationPrintVerification"
  | "validationPrintTemplateId"
  | "validationPrintSnapshot"
  | "validationPrintPolicyRevision"
>;

export function assertValidationPrintCompatible(
  mode: ShiftMode,
  input: ValidationPrintInput,
): void {
  if (mode !== "validation" && input.mode !== "none") {
    throw new BadRequestException({
      code: "VALIDATION_PRINT_MODE_INVALID",
      message: "Duplicate printing requires validation mode",
    });
  }
}

export function assertProductLabelCapability(
  policy: Pick<ValidationPrintPolicy, "mode">,
  capabilities: string | undefined,
): void {
  if (
    policy.mode === "duplicate_dm" &&
    !capabilities
      ?.split(",")
      .map((value) => value.trim())
      .includes(PRODUCT_LABEL_PROTOCOL)
  ) {
    throw new ConflictException({
      code: "STATION_UPDATE_REQUIRED",
      message: "Update the station before using duplicate printing",
    });
  }
}

export function validationPrintFromStorage(row: ValidationPrintStorage): ValidationPrintPolicy {
  return validationPrintPolicySchema.parse({
    mode: row.validationPrintMode,
    verification: row.validationPrintVerification,
    templateId: row.validationPrintTemplateId,
    snapshot: row.validationPrintSnapshot,
    policyRevision: row.validationPrintPolicyRevision,
  });
}

export function validationPrintToStorage(value: ValidationPrintPolicy): ValidationPrintStorage {
  const policy = validationPrintPolicySchema.parse(value);
  return {
    validationPrintMode: policy.mode,
    validationPrintVerification: policy.verification,
    validationPrintTemplateId: policy.templateId,
    validationPrintSnapshot: policy.snapshot,
    validationPrintPolicyRevision: policy.policyRevision,
  };
}

export function validationPrintInput(policy: ValidationPrintPolicy): ValidationPrintInput {
  return policy.mode === "none"
    ? { mode: "none" }
    : {
        mode: policy.mode,
        verification: policy.verification,
        templateId: policy.templateId,
      };
}

/** Call inside the transaction holding the shift row through planning/opening. */
export async function snapshotValidationPrintPolicy(
  db: Pick<Db, "select">,
  tenantId: string,
  productId: string,
  mode: ShiftMode,
  input: ValidationPrintInput,
  previous?: ValidationPrintPolicy,
): Promise<ValidationPrintPolicy> {
  assertValidationPrintCompatible(mode, input);
  if (input.mode === "none")
    return validationPrintPolicySchema.parse({
      mode: "none",
      verification: "none",
      templateId: null,
      snapshot: null,
      policyRevision: null,
    });
  const [product] = await db
    .select({ category: schema.products.chzProductGroupCode })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
    .for("share");
  if (!product) throw new NotFoundException("Shift product not found");
  const [template] = await db
    .select()
    .from(schema.labelTemplates)
    .where(
      and(
        eq(schema.labelTemplates.tenantId, tenantId),
        eq(schema.labelTemplates.id, input.templateId),
      ),
    )
    .for("share");
  if (!template) throw new NotFoundException("Product label template not found");
  if (
    template.purpose !== "product_duplicate" ||
    !template.enabled ||
    (template.chzProductGroupCodes !== null &&
      (product.category === null || !template.chzProductGroupCodes.includes(product.category)))
  ) {
    throw new BadRequestException({
      code: "PRODUCT_LABEL_TEMPLATE_NOT_ELIGIBLE",
      message: "Select an enabled duplicate template for this product",
    });
  }
  const spec = parseLabelTemplate(template.spec);
  assertDuplicateTemplate(spec);
  const content = { id: template.id, name: template.name, spec };
  const digest = productLabelValueDigest(content);
  if (
    previous?.mode === "duplicate_dm" &&
    previous.snapshot.digest === digest &&
    previous.verification === input.verification
  )
    return previous;
  return validationPrintPolicySchema.parse({
    ...input,
    snapshot: { ...content, digest },
    policyRevision: randomUUID(),
  });
}
