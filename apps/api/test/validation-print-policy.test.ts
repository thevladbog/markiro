import { describe, expect, it } from "vitest";
import {
  buildDuplicateLabelTemplate,
  PRODUCT_LABEL_PROTOCOL,
  productLabelValueDigest,
  validationPrintPolicySchema,
} from "@markiro/domain";
import {
  assertProductLabelCapability,
  assertValidationPrintCompatible,
  validationPrintFromStorage,
  validationPrintToStorage,
} from "../src/modules/shifts/validation-print-policy";
import { createShiftSchema, updateShiftSchema } from "../src/modules/shifts/dto";

const template = {
  id: "40000000-0000-4000-8000-000000000004",
  name: "Дубликат",
  spec: buildDuplicateLabelTemplate(),
};
const input = { mode: "duplicate_dm", verification: "required", templateId: template.id } as const;
const policy = validationPrintPolicySchema.parse({
  ...input,
  snapshot: { ...template, digest: productLabelValueDigest(template) },
  policyRevision: "40000000-0000-4000-8000-000000000005",
});

describe("validation print policy boundary", () => {
  it("only allows duplicate labels for validation", () => {
    expect(() => assertValidationPrintCompatible("aggregation", input)).toThrow();
    expect(() => assertValidationPrintCompatible("validation", input)).not.toThrow();
    expect(() => assertValidationPrintCompatible("aggregation", { mode: "none" })).not.toThrow();
  });

  it.each([undefined, "", "subscription-state-v1", `${PRODUCT_LABEL_PROTOCOL}-other`])(
    "rejects a station without the exact capability: %s",
    (capabilities) => expect(() => assertProductLabelCapability(policy, capabilities)).toThrow(),
  );

  it("accepts the capability among other comma-separated tokens", () => {
    expect(() =>
      assertProductLabelCapability(policy, `subscription-state-v1, ${PRODUCT_LABEL_PROTOCOL}`),
    ).not.toThrow();
  });

  it("preserves old clients in ordinary shifts", () => {
    const none = validationPrintFromStorage({
      validationPrintMode: "none",
      validationPrintVerification: "none",
      validationPrintTemplateId: null,
      validationPrintSnapshot: null,
      validationPrintPolicyRevision: null,
    });
    expect(() => assertProductLabelCapability(none, undefined)).not.toThrow();
    expect(none.mode).toBe("none");
  });

  it("round-trips the complete frozen policy and rejects corrupt persisted snapshots", () => {
    const row = validationPrintToStorage(policy);
    expect(validationPrintFromStorage(row)).toEqual(policy);
    expect(() => validationPrintFromStorage({ ...row, validationPrintSnapshot: {} })).toThrow();
  });

  it("retains explicit policy input at create and patch boundaries", () => {
    expect(
      createShiftSchema.parse({
        productId: template.id,
        mode: "validation",
        validationPrint: input,
      }).validationPrint,
    ).toEqual(input);
    expect(updateShiftSchema.parse({ validationPrint: { mode: "none" } }).validationPrint).toEqual({
      mode: "none",
    });
    expect(updateShiftSchema.parse({}).validationPrint).toBeUndefined();
    expect(() =>
      updateShiftSchema.parse({ validationPrint: { ...input, snapshot: template } }),
    ).toThrow();
  });
});
