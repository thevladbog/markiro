import { z } from "zod";

/** POST /station-devices body. */
export const createStationDeviceSchema = z.object({
  name: z.string().min(1).max(200),
});
export type CreateStationDeviceDto = z.infer<typeof createStationDeviceSchema>;

/** A station device summary (never carries the plaintext key). */
export interface StationDeviceDto {
  id: string;
  name: string;
  enrolledAt: Date;
  lastSeenAt: Date | null;
}

/** POST /station-devices response — the plaintext apiKey is returned ONCE. */
export interface EnrollStationDeviceResponseDto {
  deviceId: string;
  name: string;
  apiKey: string;
  serverUrl: string;
}

/** GET /station-devices response. */
export interface ListStationDevicesResponseDto {
  items: StationDeviceDto[];
}
