import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import { isShiftCloseReasonCode, type ShiftCloseReasonCode } from "@markiro/domain";

const uuid = z.string().uuid();

export const stationShiftCloseSchema = z
  .object({
    eventId: uuid,
    shiftId: uuid,
    operatorId: uuid.nullable().optional(),
    plannedQtySnapshot: z.number().int().min(0).nullable(),
    actualQty: z.number().int().min(0),
    closedBoxCount: z.number().int().min(0),
    reasonCode: z.string().nullable().optional(),
    closedAt: z.coerce.date(),
  })
  .superRefine((value, ctx) => {
    const required =
      value.plannedQtySnapshot !== null && value.plannedQtySnapshot !== value.actualQty;
    if (required && (!value.reasonCode || !isShiftCloseReasonCode(value.reasonCode))) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "A valid close reason is required",
      });
    }
    if (
      !required &&
      value.reasonCode !== undefined &&
      value.reasonCode !== null &&
      !isShiftCloseReasonCode(value.reasonCode)
    ) {
      ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "Unknown close reason" });
    }
  });
export type StationShiftCloseDto = z.infer<typeof stationShiftCloseSchema> & {
  reasonCode?: ShiftCloseReasonCode | null;
};

export interface StationShiftCloseResponseDto {
  outcome: "accepted" | "already_resolved" | "conflict";
  conflictCode?: "multiple_devices";
}

export interface ShiftCloseConflictDto {
  eventId: string;
  shiftId: string;
  productName: string | null;
  deviceId: string;
  operatorId: string | null;
  plannedQtySnapshot: number | null;
  actualQty: number;
  closedBoxCount: number;
  reasonCode: string | null;
  closedAt: Date;
  recordedAt: Date;
  conflictCode: string | null;
}

export interface ShiftCloseConflictListDto {
  items: ShiftCloseConflictDto[];
}

const uuidOpenApiSchema = { type: "string", format: "uuid" } as const;
const dateTimeOpenApiSchema = { type: "string", format: "date-time" } as const;

/**
 * Hand-written: `closedAt: z.coerce.date()` is not representable by
 * `z.toJSONSchema`, so the body schema cannot be derived from the zod schema.
 */
export const stationShiftCloseOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["eventId", "shiftId", "plannedQtySnapshot", "actualQty", "closedBoxCount", "closedAt"],
  properties: {
    eventId: uuidOpenApiSchema,
    shiftId: uuidOpenApiSchema,
    operatorId: { ...uuidOpenApiSchema, nullable: true },
    plannedQtySnapshot: { type: "integer", minimum: 0, nullable: true },
    actualQty: { type: "integer", minimum: 0 },
    closedBoxCount: { type: "integer", minimum: 0 },
    reasonCode: {
      type: "string",
      nullable: true,
      description:
        "Required when plannedQtySnapshot is set and differs from actualQty; must then be a known close reason code.",
    },
    closedAt: dateTimeOpenApiSchema,
  },
};

export const stationShiftCloseResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["accepted", "already_resolved", "conflict"] },
    conflictCode: { type: "string", enum: ["multiple_devices"] },
  },
};

const shiftCloseConflictOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "eventId",
    "shiftId",
    "productName",
    "deviceId",
    "operatorId",
    "plannedQtySnapshot",
    "actualQty",
    "closedBoxCount",
    "reasonCode",
    "closedAt",
    "recordedAt",
    "conflictCode",
  ],
  properties: {
    eventId: uuidOpenApiSchema,
    shiftId: uuidOpenApiSchema,
    productName: { type: "string", nullable: true },
    deviceId: uuidOpenApiSchema,
    operatorId: { ...uuidOpenApiSchema, nullable: true },
    plannedQtySnapshot: { type: "integer", minimum: 0, nullable: true },
    actualQty: { type: "integer", minimum: 0 },
    closedBoxCount: { type: "integer", minimum: 0 },
    reasonCode: { type: "string", nullable: true },
    closedAt: dateTimeOpenApiSchema,
    recordedAt: dateTimeOpenApiSchema,
    conflictCode: { type: "string", nullable: true },
  },
};

export const shiftCloseConflictListOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: shiftCloseConflictOpenApiSchema } },
};
