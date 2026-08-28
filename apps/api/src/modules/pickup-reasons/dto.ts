import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

/** POST /pickup-reasons schema. */
export const createReasonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().default(0),
});
export type CreateReasonDto = z.infer<typeof createReasonSchema>;

/** PATCH /pickup-reasons/:id schema. */
export const updateReasonSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateReasonDto = z.infer<typeof updateReasonSchema>;

/** Response DTO for a pickup write-off reason. */
export interface ReasonDto {
  id: string;
  name: string;
  sortOrder: number;
}

/** GET /pickup-reasons response. */
export interface ListReasonsResponseDto {
  items: ReasonDto[];
}

// --- OpenAPI response schemas (hand-written: the response DTOs above are ---
// --- interfaces, not zod schemas; see inventories/dto.ts for the pattern) ---

export const reasonOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["id", "name", "sortOrder"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    sortOrder: { type: "integer" },
  },
};

export const listReasonsOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: reasonOpenApiSchema } },
};
