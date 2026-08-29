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

/** `POST /chz-exports/retry`'s 409 error surface: named rather than inline. */
export const CHZ_EXPORT_NOT_FAILED_CODE = "CHZ_EXPORT_NOT_FAILED" as const;
/**
 * Distinct from the run's own `errorCode` (`CHZ_CREATE_ATTEMPTS_EXHAUSTED`,
 * set by `ChzExportRunnerService`): this is what `retry()` itself answers
 * when it refuses to reset a run that is already at the creation-attempt cap,
 * so the caller never mistakes "retry accepted, will fail again" for a real
 * retry.
 */
export const CHZ_EXPORT_RETRY_EXHAUSTED_CODE = "CHZ_EXPORT_RETRY_EXHAUSTED" as const;
export const CHZ_EXPORT_RETRY_REJECTION_CODES = [
  CHZ_EXPORT_NOT_FAILED_CODE,
  CHZ_EXPORT_RETRY_EXHAUSTED_CODE,
] as const;
export type ChzExportRetryRejectionCode = (typeof CHZ_EXPORT_RETRY_REJECTION_CODES)[number];

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
