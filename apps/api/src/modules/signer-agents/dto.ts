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
  tokenType: "jwt" | "uuid" | null;
  obtainedAt: string | null;
  expiresAt: string | null;
  certThumbprint: string | null;
}

export type SignerRefreshTaskStatus = "pending" | "claimed" | "completed" | "failed" | "expired";

export interface SignerRefreshTaskDto {
  id: string;
  status: SignerRefreshTaskStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SignerAgentsOverviewDto {
  agents: SignerAgentSummaryDto[];
  token: SignerTokenStatusDto;
  refreshTask: SignerRefreshTaskDto | null;
}

export interface IssueSignerPairingCodeResultDto {
  code: string;
  expiresAt: Date;
}

export interface RequestSignerTokenRefreshResultDto {
  status: "queued" | "already_pending";
  taskId: string;
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
  required: ["status", "tokenType", "obtainedAt", "expiresAt", "certThumbprint"],
  properties: {
    status: { type: "string", enum: ["none", "active", "expiring", "expired"] },
    tokenType: { type: "string", enum: ["jwt", "uuid"], nullable: true },
    obtainedAt: { type: "string", format: "date-time", nullable: true },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    certThumbprint: { type: "string", nullable: true },
  },
};

const signerRefreshTaskOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "errorCode", "errorMessage", "createdAt", "completedAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: {
      type: "string",
      enum: ["pending", "claimed", "completed", "failed", "expired"],
    },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    completedAt: { type: "string", format: "date-time", nullable: true },
  },
};

export const signerAgentsOverviewOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["agents", "token", "refreshTask"],
  properties: {
    agents: { type: "array", items: signerAgentSummaryOpenApiSchema },
    token: signerTokenStatusOpenApiSchema,
    refreshTask: { ...signerRefreshTaskOpenApiSchema, nullable: true },
  },
};

const signerTaskOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "payload"],
  properties: {
    id: { type: "string", format: "uuid" },
    type: { type: "string", enum: ["true_api_auth"] },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["trueApiBaseUrl"],
      properties: {
        trueApiBaseUrl: { type: "string", format: "uri" },
        inn: { type: "string" },
        tokenFormat: { type: "string", enum: ["jwt", "uuid"] },
      },
    },
  },
};

/** `GET /signer-agent/tasks/next` response: no queued task is `{ task: null }`, not a 404. */
export const nextTaskOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["task"],
  properties: {
    task: { ...signerTaskOpenApiSchema, nullable: true },
  },
};
