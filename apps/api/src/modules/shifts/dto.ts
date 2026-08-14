import { z } from "zod";
import type { LabelTemplateSpec } from "@markiro/domain";
import type { OperatorMirrorRecord } from "@markiro/db";
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
  /**
   * Whose numbers this shift's boxes carry. Deliberately NOT derived from
   * `counterpartyId` -- that field answers "who is this for", this one
   * answers "whose numbers" -- see the field comment on the `shifts` table.
   * Omitted/null means the tenant's own organisation.
   */
  ssccIssuerCounterpartyId: z.string().uuid().nullable().optional(),
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
  plannedQty: z.number().int().min(1).nullable().optional(),
  plannedDate: plannedDateSchema.nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  palletsEnabled: z.boolean().optional(),
});
export type CreateShiftDto = z.infer<typeof createShiftSchema>;

/**
 * PATCH /shifts/:id schema. Planned shifts accept the full shape; the service
 * restricts active shifts to line/date/quantity/box-template metadata.
 */
export const updateShiftSchema = z.object({
  mode: z.enum(SHIFT_MODES).optional(),
  lineId: z.string().uuid().nullable().optional(),
  counterpartyId: z.string().uuid().nullable().optional(),
  labelTemplateId: z.string().uuid().nullable().optional(),
  ssccIssuerCounterpartyId: z.string().uuid().nullable().optional(),
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
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
  /** Whose numbers this shift's boxes carry; null means the tenant's own organisation. */
  ssccIssuerCounterpartyId: string | null;
  boxLabelTemplateId: string | null;
  plannedQty: number | null;
  plannedDate: string | null;
  boxCapacity: number | null;
  palletCapacity: number | null;
  palletsEnabled: boolean;
  createdFrom: ShiftOrigin;
  openedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  /** When scans first arrived after this shift was closed; null if never. */
  lateDataAt: Date | null;
  createdAt: Date;
}

/** GET /shifts response. */
export interface ListShiftsResponseDto {
  items: ShiftDto[];
}

/** GET /shifts/:id/bundle response — everything the station downloads offline. */
export interface ShiftBundleDto {
  shift: ShiftDto;
  product: ProductDto;
  labelTemplate: { id: string; name: string; spec: LabelTemplateSpec } | null;
  /**
   * The BOX label's own template (CodeRabbit PR33 review, Finding 3),
   * resolved from `shift.boxLabelTemplateId` -- entirely separate from
   * `labelTemplate` above, which is the ITEM label's template. Before this
   * field existed, the station mirrored only `labelTemplate` and used it for
   * every print, box included, so a shift with a distinct box template
   * either printed the item template on every box or (when only a box
   * template was configured) printed nothing at all. Null exactly when
   * `shift.boxLabelTemplateId` is null or no longer resolves to a template
   * this tenant owns -- same shape `labelTemplate` already has, no fallback
   * to any other template.
   */
  boxLabelTemplate: { id: string; name: string; spec: LabelTemplateSpec } | null;
  counterpartyGln: string | null;
  operators: OperatorMirrorRecord[];
  /**
   * The box serial block this device may print from -- aggregation shifts
   * only (a validation shift closes no boxes, so allocating one would burn
   * serials nothing will ever print), and only when the caller is an actual
   * station device (no device to attribute a block to otherwise).
   *
   * `fromSerial`/`toSerial` are always the block's ORIGINAL bounds, even on
   * a repeat fetch of an already-held block -- never shrunk to the
   * unconsumed remainder (final review, finding 1: a shrunk `fromSerial`
   * doesn't match the device's already-held row's primary key, so it was
   * inserted as a second, overlapping range instead of reconciling the
   * first). `consumedThroughSerial` carries the same cursor
   * `SsccService.recordConsumedSerial` tracks server-side, so the device
   * can advance (never regress) its own local cursor against the row it
   * already has, or seed a lost one correctly, instead of being handed a
   * range shaped like a brand new block.
   */
  sscc: {
    issuerPrefix: string;
    extensionDigit: number;
    fromSerial: number;
    toSerial: number;
    consumedThroughSerial: number | null;
  } | null;
}
