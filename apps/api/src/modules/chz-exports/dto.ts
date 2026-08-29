import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

export const CHZ_EXPORT_PREFLIGHT_CODES = [
  "INN_MISSING",
  "PRODUCT_GROUP_MISSING",
  "AGENT_NOT_PAIRED",
  "TOKEN_UNAVAILABLE",
] as const;
export type ChzExportPreflightCode = (typeof CHZ_EXPORT_PREFLIGHT_CODES)[number];

export const CHZ_EXPORT_RUN_STATES = ["queued", "ordered", "ready", "imported", "failed"] as const;
export type ChzExportRunState = (typeof CHZ_EXPORT_RUN_STATES)[number];

export interface ChzExportRunDto {
  status: InventoryChzStatus;
  state: ChzExportRunState;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  importId: string | null;
  orderedAt: string | null;
  completedAt: string | null;
}

export interface ChzExportStateDto {
  available: boolean;
  blockedBy: ChzExportPreflightCode[];
  runs: ChzExportRunDto[];
}

export const retryChzExportSchema = z.object({
  status: z.enum(INVENTORY_CHZ_STATUSES),
});
export type RetryChzExportDto = z.infer<typeof retryChzExportSchema>;

export const retryChzExportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] } },
};

export const chzExportStateOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["available", "blockedBy", "runs"],
  properties: {
    available: { type: "boolean" },
    blockedBy: {
      type: "array",
      items: { type: "string", enum: [...CHZ_EXPORT_PREFLIGHT_CODES] },
    },
    runs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "state",
          "attempts",
          "errorCode",
          "errorMessage",
          "importId",
          "orderedAt",
          "completedAt",
        ],
        properties: {
          status: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] },
          state: { type: "string", enum: [...CHZ_EXPORT_RUN_STATES] },
          attempts: { type: "integer" },
          errorCode: { type: "string", nullable: true },
          errorMessage: { type: "string", nullable: true },
          importId: { type: "string", format: "uuid", nullable: true },
          orderedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
};
