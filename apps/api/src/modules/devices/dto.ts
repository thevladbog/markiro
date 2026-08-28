import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

export const deviceTypes = ["station", "kiosk"] as const;
export type DeviceType = (typeof deviceTypes)[number];

export const deviceStatuses = ["awaiting_pairing", "online", "offline", "revoked"] as const;
export type DeviceStatus = (typeof deviceStatuses)[number];

/** GET /devices query. Pagination happens after the unified lifecycle filter. */
export const listDevicesQuerySchema = z.object({
  type: z.enum(deviceTypes).optional(),
  status: z.enum(deviceStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(8),
});
export type ListDevicesQueryDto = z.infer<typeof listDevicesQuerySchema>;

export interface DeviceDto {
  id: string;
  type: DeviceType;
  name: string;
  place: { id: string | null; name: string | null };
  status: DeviceStatus;
  lastSeenAt: Date | null;
  paired: boolean;
}

export interface ListDevicesResponseDto {
  items: DeviceDto[];
  page: number;
  pageSize: number;
  total: number;
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const deviceOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["id", "type", "name", "place", "status", "lastSeenAt", "paired"],
  properties: {
    id: uuidSchema,
    type: { type: "string", enum: [...deviceTypes] },
    name: { type: "string" },
    place: {
      type: "object",
      required: ["id", "name"],
      description:
        "A station's assigned line (id + name) or a kiosk's free-form location (id is always null).",
      properties: {
        id: { ...uuidSchema, nullable: true },
        name: { type: "string", nullable: true },
      },
    },
    status: { type: "string", enum: [...deviceStatuses] },
    lastSeenAt: { ...dateTimeSchema, nullable: true },
    paired: { type: "boolean" },
  },
};

export const listDevicesOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items", "page", "pageSize", "total"],
  properties: {
    items: { type: "array", items: deviceOpenApiSchema },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 50 },
    total: { type: "integer", minimum: 0 },
  },
};
