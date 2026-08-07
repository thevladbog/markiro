import { z } from "zod";
import type { OperatorMirrorRecord } from "@markiro/db";

export const pairStationSchema = z.object({
  code: z.string().regex(/^\d{8}$/),
});
export type PairStationDto = z.infer<typeof pairStationSchema>;

export type StationPairErrorCode =
  "PAIR_INVALID" | "PAIR_EXPIRED" | "PAIR_LOCKED" | "PAIR_RATE_LIMITED";

export interface IssueStationPairingCodeResultDto {
  code: string;
  expiresAt: Date;
}

export interface PairStationResultDto {
  device: {
    id: string;
    name: string;
    tenantId: string;
    organizationName: string;
    line: { id: string; name: string } | null;
  };
  credential: { apiKey: string; serverUrl: string };
  operators: OperatorMirrorRecord[];
}

/** Authenticated legacy-config bootstrap; deliberately contains no credential material. */
export type StationIdentityResultDto = Pick<PairStationResultDto, "device">;
