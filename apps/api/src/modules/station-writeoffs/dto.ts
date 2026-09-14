import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";
import { boxConflictOpenApiSchema, orderConflictOpenApiSchema } from "../pickup-orders/dto";

/**
 * A handheld write-off.
 *
 * Deliberately NOT the kiosk's `createOrderSchema`. There is no badge identity
 * (the operator is asserted by the signed-in device), no price, and no `reason`
 * field at all: this route is fixed to `writeoff` server-side and must not be
 * able to create a purchase.
 */
export const stationWriteoffSchema = z
  .object({
    deviceSeq: z.number().int().nonnegative(),
    operatorId: z.string().uuid().toLowerCase(),
    writeoffReasonId: z.string().uuid().toLowerCase(),
    items: z.array(z.object({ rawKm: z.string().min(1) })).default([]),
    boxes: z.array(z.object({ sscc: z.string().length(18) })).default([]),
    createdAt: z.string().datetime(),
  })
  .refine((v) => v.items.length + v.boxes.length > 0, "At least one item or box is required")
  .refine(
    (v) => new Set(v.boxes.map((b) => b.sscc)).size === v.boxes.length,
    "Box SSCC values must be unique",
  );
export type StationWriteoffDto = z.infer<typeof stationWriteoffSchema>;

/** Everything the device needs to run the write-off mode offline. */
export interface StationWriteoffBootstrapDto {
  /** Server time, feeding the device's «данные на 10:42» stamp. */
  generatedAt: string;
  reasons: { id: string; name: string; sortOrder: number }[];
  /** `id` is what the box registry names a product by; `gtin14` is what a unit scan resolves through. */
  products: { id: string; gtin14: string; name: string }[];
  operators: { employeeId: string; canWriteoff: boolean }[];
}

export const stationWriteoffOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["deviceSeq", "operatorId", "writeoffReasonId", "createdAt"],
  properties: {
    deviceSeq: { type: "integer", minimum: 0 },
    operatorId: { type: "string", format: "uuid" },
    writeoffReasonId: { type: "string", format: "uuid" },
    items: {
      type: "array",
      items: { type: "object", required: ["rawKm"], properties: { rawKm: { type: "string" } } },
    },
    boxes: {
      type: "array",
      items: {
        type: "object",
        required: ["sscc"],
        properties: { sscc: { type: "string", pattern: "^[0-9]{18}$" } },
      },
    },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const stationWriteoffBootstrapOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["generatedAt", "reasons", "products", "operators"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    reasons: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "sortOrder"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          sortOrder: { type: "integer" },
        },
      },
    },
    products: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "gtin14", "name"],
        properties: {
          id: { type: "string", format: "uuid" },
          gtin14: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    operators: {
      type: "array",
      items: {
        type: "object",
        required: ["employeeId", "canWriteoff"],
        properties: {
          employeeId: { type: "string", format: "uuid" },
          canWriteoff: { type: "boolean" },
        },
      },
    },
  },
};

/**
 * The write-off outcome is the kiosk's `CreateOrderResultDto`, so the device
 * reuses one outcome shape. Assembled from the exported conflict schemas rather
 * than duplicating the kiosk controller's inline copy.
 */
export const stationWriteoffResultOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["orderNo", "status", "itemCount", "conflicts", "boxConflicts", "acceptedBoxes"],
  properties: {
    orderNo: { type: "string" },
    status: { type: "string", enum: ["pending"] },
    itemCount: { type: "integer", minimum: 0 },
    conflicts: { type: "array", items: orderConflictOpenApiSchema },
    boxConflicts: { type: "array", items: boxConflictOpenApiSchema },
    acceptedBoxes: {
      type: "array",
      items: {
        type: "object",
        required: ["sscc", "bottleCount"],
        properties: {
          sscc: { type: "string", pattern: "^[0-9]{18}$" },
          bottleCount: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};
