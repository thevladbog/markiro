import { z } from "zod";

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
