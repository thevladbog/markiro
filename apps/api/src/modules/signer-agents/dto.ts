import type { SchemaObject } from "@nestjs/swagger";
import {
  chzSignerPairRequestSchema,
  type ChzSignerPairRequest,
  type ChzSignerPairResponse,
} from "@markiro/platform-contracts";
import type { ChzTokenUiStatus } from "./chz-constants";

export const pairSignerAgentSchema = chzSignerPairRequestSchema;
export type PairSignerAgentDto = ChzSignerPairRequest;
export type PairSignerAgentResultDto = ChzSignerPairResponse;

export interface SignerAgentSummaryDto {
  id: string;
  name: string;
  appVersion: string | null;
  status: "active" | "revoked";
  certThumbprint: string | null;
  certSubject: string | null;
  certInn: string | null;
  certNotAfter: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SignerTokenStatusDto {
  status: ChzTokenUiStatus;
  obtainedAt: string | null;
  expiresAt: string | null;
  certThumbprint: string | null;
}

export interface SignerAgentsOverviewDto {
  agents: SignerAgentSummaryDto[];
  token: SignerTokenStatusDto;
}

export interface IssueSignerPairingCodeResultDto {
  code: string;
  expiresAt: Date;
}

const signerAgentSummaryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "appVersion",
    "status",
    "certThumbprint",
    "certSubject",
    "certInn",
    "certNotAfter",
    "lastSeenAt",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    appVersion: { type: "string", nullable: true },
    status: { type: "string", enum: ["active", "revoked"] },
    certThumbprint: { type: "string", nullable: true },
    certSubject: { type: "string", nullable: true },
    certInn: { type: "string", nullable: true },
    certNotAfter: { type: "string", format: "date-time", nullable: true },
    lastSeenAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
};

const signerTokenStatusOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "obtainedAt", "expiresAt", "certThumbprint"],
  properties: {
    status: { type: "string", enum: ["none", "active", "expiring", "expired"] },
    obtainedAt: { type: "string", format: "date-time", nullable: true },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    certThumbprint: { type: "string", nullable: true },
  },
};

export const signerAgentsOverviewOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["agents", "token"],
  properties: {
    agents: { type: "array", items: signerAgentSummaryOpenApiSchema },
    token: signerTokenStatusOpenApiSchema,
  },
};
