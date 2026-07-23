import { z } from "zod";
import type { LabelTemplateSpec } from "@markiro/domain";
import type { ProductDto } from "../products/dto";

const SHIFT_MODES = ["validation", "aggregation"] as const;
export type ShiftMode = (typeof SHIFT_MODES)[number];

const SHIFT_STATUSES = ["planned", "active", "closed"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Server-computed only (never client-submitted); "admin" for shifts created here. */
export type ShiftOrigin = "admin" | "station";

/** `YYYY-MM-DD`, matches the `date` column's string mode. */
const plannedDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "plannedDate must be YYYY-MM-DD");

/**
 * POST /shifts schema. `boxCapacity`/`palletCapacity`/`counterpartyId`/
 * `labelTemplateId` are server-prefilled from the product when omitted
 * (`undefined`); an explicit `null` opts out of the prefill (see
 * ShiftsService.createShift).
 */
export const createShiftSchema = z.object({
  productId: z.string().uuid(),
  mode: z.enum(SHIFT_MODES),
  lineId: z.string().uuid().nullable().optional(),
  counterpartyId: z.string().uuid().nullable().optional(),
  labelTemplateId: z.string().uuid().nullable().optional(),
  plannedQty: z.number().int().min(1).nullable().optional(),
  plannedDate: plannedDateSchema.nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  palletsEnabled: z.boolean().optional(),
});
export type CreateShiftDto = z.infer<typeof createShiftSchema>;

/** PATCH /shifts/:id schema -- partial update, only while `status === "planned"`. */
export const updateShiftSchema = z.object({
  mode: z.enum(SHIFT_MODES).optional(),
  lineId: z.string().uuid().nullable().optional(),
  counterpartyId: z.string().uuid().nullable().optional(),
  labelTemplateId: z.string().uuid().nullable().optional(),
  plannedQty: z.number().int().min(1).nullable().optional(),
  plannedDate: plannedDateSchema.nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  palletsEnabled: z.boolean().optional(),
});
export type UpdateShiftDto = z.infer<typeof updateShiftSchema>;

/** POST /shifts/:id/close schema. */
export const closeShiftSchema = z.object({
  reason: z.string().min(3),
});
export type CloseShiftDto = z.infer<typeof closeShiftSchema>;

/** GET /shifts query schema. `from`/`to` filter on `plannedDate`, inclusive. */
export const listShiftsQuerySchema = z.object({
  status: z.enum(SHIFT_STATUSES).optional(),
  from: plannedDateSchema.optional(),
  to: plannedDateSchema.optional(),
  lineId: z.string().uuid().optional(),
});
export type ListShiftsQueryDto = z.infer<typeof listShiftsQuerySchema>;

/** Response DTO for a shift, joined with product/line/counterparty names. */
export interface ShiftDto {
  id: string;
  status: ShiftStatus;
  mode: ShiftMode;
  productId: string;
  productName: string | null;
  lineId: string | null;
  lineName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  labelTemplateId: string | null;
  labelTemplateName: string | null;
  plannedQty: number | null;
  plannedDate: string | null;
  boxCapacity: number | null;
  palletCapacity: number | null;
  palletsEnabled: boolean;
  createdFrom: ShiftOrigin;
  openedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  createdAt: Date;
}

/** GET /shifts response. */
export interface ListShiftsResponseDto {
  items: ShiftDto[];
}

/**
 * A station-local operator record. In 05a the bundle returns `[]` for
 * `operators` (the server operators table is a PARALLEL 05b workstream); this
 * type pins the shape the station will hydrate into `operators_mirror`.
 */
export interface OperatorMirrorRecord {
  operatorId: string;
  name: string;
  role: string;
  pinHash: string;
  badgeHash: string | null;
  active: boolean;
}

/** GET /shifts/:id/bundle response — everything the station downloads offline. */
export interface ShiftBundleDto {
  shift: ShiftDto;
  product: ProductDto;
  labelTemplate: { id: string; name: string; spec: LabelTemplateSpec } | null;
  counterpartyGln: string | null;
  operators: OperatorMirrorRecord[];
}
