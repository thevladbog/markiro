import { z } from "zod";
import {
  warehouseSourceSchema,
  warehouseTemplateSchema,
  warehouseReasonSchema,
  warehouseEventSchema,
  type WarehouseReprintProjection,
  type WarehouseReprintEvent,
} from "@markiro/domain";
import type { PrinterProfile } from "../printer-routing.js";

export const warehouseSessionSchema = z.strictObject({
  owner: z.string().min(1),
  sessionId: z.uuid(),
  operatorId: z.uuid(),
  reason: warehouseReasonSchema,
  status: z.enum(["active", "paused"]),
  unitTemplate: warehouseTemplateSchema.nullable(),
  boxTemplate: warehouseTemplateSchema.nullable(),
  sentCount: z.number().int().nonnegative().default(0),
});
export type WarehouseSession = z.output<typeof warehouseSessionSchema>;
export type WarehouseSessionInput = z.input<typeof warehouseSessionSchema>;
export const warehousePreparedInputSchema = z.strictObject({
  owner: z.string().min(1),
  sessionId: z.uuid(),
  jobId: z.uuid(),
  deviceId: z.uuid(),
  operatorId: z.uuid(),
  reason: warehouseReasonSchema,
  source: warehouseSourceSchema,
  template: warehouseTemplateSchema,
  fields: warehouseSourceSchema.shape.fields,
  bytesBase64: z.string().min(1),
  bytesDigest: z.string().regex(/^[0-9a-f]{64}$/),
  preparedEvent: z.union([warehouseEventSchema.options[0], warehouseEventSchema.options[1]]),
});
export interface WarehousePreparedJobInput extends z.infer<typeof warehousePreparedInputSchema> {
  printer: PrinterProfile;
}
export interface WarehouseJob extends WarehousePreparedJobInput {
  projection: WarehouseReprintProjection;
  updatedAt: string;
}
export interface WarehouseJobView {
  printScope?: string;
  jobId: string;
  attemptId: string;
  attemptNo: number;
  state: WarehouseReprintProjection["state"];
  kind: "unit" | "box";
  identity: string;
  productName: string;
  templateName: string;
  printerName: string;
  repair: Extract<WarehouseReprintEvent, { kind: "prepared" }>["repair"];
  updatedAt: string;
}
