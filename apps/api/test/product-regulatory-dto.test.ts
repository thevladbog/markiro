import { describe, expect, it } from "vitest";

import { regulatoryProfileOpenApiSchema } from "../src/modules/product-regulatory/dto";

describe("product regulatory OpenAPI", () => {
  it("documents the pinned category definition on every profile response", () => {
    expect(regulatoryProfileOpenApiSchema.required).toContain("definition");
    expect(regulatoryProfileOpenApiSchema.properties?.definition).toMatchObject({
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["formatVersion", "categoryId", "scopeKey", "attributes"],
          properties: {
            formatVersion: { type: "integer", enum: [2] },
            categoryId: { type: "string" },
            scopeKey: { type: "string" },
            attributes: { type: "array" },
          },
        },
        expect.objectContaining({ nullable: true }),
      ],
    });
  });
});
