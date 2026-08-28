import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

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

export interface LinePresenceDto {
  lineId: string;
  lineName: string;
  assignedStations: number;
  onlineStations: number;
  lastSeenAt: Date | null;
}

export interface ListLinePresenceResponseDto {
  items: LinePresenceDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const lineOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["id", "name", "createdAt"],
  properties: {
    id: uuidSchema,
    name: { type: "string" },
    createdAt: dateTimeSchema,
  },
};

export const listLinesOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: lineOpenApiSchema } },
};

export const linePresenceOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["lineId", "lineName", "assignedStations", "onlineStations", "lastSeenAt"],
  properties: {
    lineId: uuidSchema,
    lineName: { type: "string" },
    assignedStations: { type: "integer", minimum: 0 },
    onlineStations: { type: "integer", minimum: 0 },
    lastSeenAt: { ...dateTimeSchema, nullable: true },
  },
};

export const listLinePresenceOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: linePresenceOpenApiSchema } },
};
