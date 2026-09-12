import { describe, expect, it, vi } from "vitest";
import { LabelTemplatesService } from "../src/modules/label-templates/label-templates.service";
import { buildDuplicateLabelTemplate } from "@markiro/domain";
import {
  createLabelTemplateSchema,
  updateLabelTemplateSchema,
  labelTemplateOpenApiSchema,
  labelTemplateSummaryOpenApiSchema,
} from "../src/modules/label-templates/dto";

describe("label template purpose contract", () => {
  it("defaults legacy creates to box and preserves an explicit duplicate purpose", () => {
    const input = { name: "Дубликат", spec: buildDuplicateLabelTemplate() };
    expect(createLabelTemplateSchema.parse(input).purpose).toBe("box");
    expect(
      createLabelTemplateSchema.parse({ ...input, purpose: "product_duplicate" }).purpose,
    ).toBe("product_duplicate");
    expect(createLabelTemplateSchema.safeParse({ ...input, purpose: "unknown" }).success).toBe(
      false,
    );
  });

  it("retains purpose in PATCH for the service to reject a change, leaving legacy patches partial", () => {
    expect(updateLabelTemplateSchema.parse({ name: "Changed" })).toEqual({ name: "Changed" });
    expect(updateLabelTemplateSchema.parse({ purpose: "box" })).toEqual({ purpose: "box" });
  });

  it("documents purpose on full and summary responses", () => {
    for (const schema of [labelTemplateOpenApiSchema, labelTemplateSummaryOpenApiSchema]) {
      expect(schema.required).toContain("purpose");
      // "pallet" joined the RESPONSE enum in 06d: tenant provisioning creates a
      // pallet-purpose row and neither list nor get-by-id filters by purpose,
      // so both schemas must document it. It is deliberately absent from
      // `purposeSchema` above, which is the narrower CREATE input.
      expect(schema.properties?.purpose).toEqual({
        type: "string",
        enum: ["box", "product_duplicate", "pallet"],
      });
    }
  });
});

describe("LabelTemplatesService delete conflicts", () => {
  it("rethrows a 23503 from an unrelated constraint", async () => {
    const databaseError = Object.assign(new Error("unrelated reference"), {
      code: "23503",
      constraint: "unrelated_foreign_key",
    });
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ for: async () => [{ id: "a0000000-0000-4000-8000-000000000001" }] }),
        }),
      })),
      delete: () => ({ where: async () => Promise.reject(databaseError) }),
    };
    const transactionDb = {
      ...db,
      transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db),
    };
    const service = new LabelTemplatesService(
      transactionDb as never,
      { capture: async () => undefined, observe: async () => undefined } as never,
    );

    await expect(
      service.deleteLabelTemplate("tenant-a", "a0000000-0000-4000-8000-000000000001", "user-a"),
    ).rejects.toBe(databaseError);
  });
});
