import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";

/** POST /station-devices body. A station exists before it has a credential. */
export const createStationDeviceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  lineId: z.string().uuid().nullable(),
});
export type CreateStationDeviceDto = z.infer<typeof createStationDeviceSchema>;

/** PATCH /station-devices/:id body. Omitted fields are preserved. */
export const updateStationDeviceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  lineId: z.string().uuid().nullable().optional(),
});
export type UpdateStationDeviceDto = z.infer<typeof updateStationDeviceSchema>;

export type StationDeviceLifecycle = "awaiting_pairing" | "online" | "offline" | "revoked";

/** A device is online only when it has phoned home during the last two minutes. */
export const STATION_ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

export interface StationDeviceLifecycleInput {
  apiKeyId: string | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

/** Single source for the API and tests; `now` keeps the boundary deterministic. */
export function stationDeviceLifecycle(
  device: StationDeviceLifecycleInput,
  now: Date = new Date(),
): StationDeviceLifecycle {
  if (device.revokedAt !== null) return "revoked";
  if (device.apiKeyId === null) return "awaiting_pairing";
  if (
    device.lastSeenAt !== null &&
    device.lastSeenAt.getTime() <= now.getTime() &&
    now.getTime() - device.lastSeenAt.getTime() <= STATION_ONLINE_THRESHOLD_MS
  ) {
    return "online";
  }
  return "offline";
}

/** A station summary (never carries credential or pairing-code plaintext). */
export interface StationDeviceDto {
  id: string;
  name: string;
  lineId: string | null;
  lineName: string | null;
  lifecycle: StationDeviceLifecycle;
  pairedAt: Date | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/** GET /station-devices response. */
export interface ListStationDevicesResponseDto {
  items: StationDeviceDto[];
}

const nullableDateTimeOpenApiSchema = {
  type: "string",
  format: "date-time",
  nullable: true,
} as const;

export const stationDeviceOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "lineId",
    "lineName",
    "lifecycle",
    "pairedAt",
    "revokedAt",
    "lastSeenAt",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    lineId: { type: "string", format: "uuid", nullable: true },
    lineName: { type: "string", nullable: true },
    lifecycle: { type: "string", enum: ["awaiting_pairing", "online", "offline", "revoked"] },
    pairedAt: nullableDateTimeOpenApiSchema,
    revokedAt: nullableDateTimeOpenApiSchema,
    lastSeenAt: nullableDateTimeOpenApiSchema,
    createdAt: { type: "string", format: "date-time" },
  },
};

export const listStationDevicesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: stationDeviceOpenApiSchema } },
};
