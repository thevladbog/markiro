import { z } from "zod";

/** POST /lines schema. */
export const createLineSchema = z.object({
  name: z.string().min(1).max(200),
});
export type CreateLineDto = z.infer<typeof createLineSchema>;

/** PATCH /lines/:id schema. */
export const updateLineSchema = z.object({
  name: z.string().min(1).max(200),
});
export type UpdateLineDto = z.infer<typeof updateLineSchema>;

/** Response DTO for a production line. */
export interface LineDto {
  id: string;
  name: string;
  createdAt: Date;
}

/** GET /lines response. */
export interface ListLinesResponseDto {
  items: LineDto[];
}
