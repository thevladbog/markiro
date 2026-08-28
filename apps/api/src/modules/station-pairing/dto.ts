import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { SubscriptionAccessSnapshot } from "../../subscriptions/entitlements.types";

export const pairStationSchema = z.object({
  code: z.string().regex(/^\d{8}$/),
});
export type PairStationDto = z.infer<typeof pairStationSchema>;

export type StationPairErrorCode =
  "PAIR_INVALID" | "PAIR_EXPIRED" | "PAIR_LOCKED" | "PAIR_RATE_LIMITED";

/** 401 body of POST /station/pair; rate limiting also surfaces here, not as 429. */
export const stationPairErrorOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["code"],
  properties: {
    code: {
      type: "string",
      enum: ["PAIR_INVALID", "PAIR_EXPIRED", "PAIR_LOCKED", "PAIR_RATE_LIMITED"],
    },
  },
};

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
  subscription?: SubscriptionAccessSnapshot;
}

/** Authenticated legacy-config bootstrap; deliberately contains no credential material. */
export type StationIdentityResultDto = Pick<PairStationResultDto, "device"> &
  Partial<Pick<PairStationResultDto, "subscription">>;
