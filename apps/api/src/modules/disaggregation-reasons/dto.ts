import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";

/** POST /disaggregation-reasons schema. */
export const createReasonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().default(0),
});
export type CreateReasonDto = z.infer<typeof createReasonSchema>;

/** PATCH /disaggregation-reasons/:id schema. */
export const updateReasonSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateReasonDto = z.infer<typeof updateReasonSchema>;

/** Response DTO for a disaggregation reason. */
export interface ReasonDto {
  id: string;
  name: string;
  sortOrder: number;
}

/** GET /disaggregation-reasons response. */
export interface ListReasonsResponseDto {
  items: ReasonDto[];
}

export const disaggregationReasonOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "sortOrder"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 120 },
    sortOrder: { type: "integer" },
  },
};

export const listDisaggregationReasonsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: disaggregationReasonOpenApiSchema } },
};
