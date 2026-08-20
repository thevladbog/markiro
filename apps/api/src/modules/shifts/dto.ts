import { z } from "zod";
import type { LabelTemplateSpec } from "@markiro/domain";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { ProductDto, ProductImageDescriptor } from "../products/dto";

const SHIFT_MODES = ["validation", "aggregation"] as const;
export type ShiftMode = (typeof SHIFT_MODES)[number];

const SHIFT_STATUSES = ["planned", "active", "closed"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Server-computed only (never client-submitted); "admin" for shifts created here. */
export type ShiftOrigin = "admin" | "station";

export type BoxTemplateResolution =
  | { ok: true; boxLabelTemplateId: string | null }
  | { ok: false; code: "BOX_LABEL_TEMPLATE_REQUIRED" };

export type StationCloseAccess =
  { kind: "single_device"; ownerDeviceId: string } | { kind: "admin_only" };

/** `YYYY-MM-DD`, matches the `date` column's string mode. */
const plannedDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "plannedDate must be YYYY-MM-DD");

/**
 * POST /shifts schema. `boxCapacity`/`palletCapacity`/`counterpartyId`
 * are server-prefilled from the product when omitted (`undefined`); an
 * explicit `null` opts out of the prefill (see ShiftsService.createShift).
 */
export const createShiftSchema = z.object({
  productId: z.string().uuid(),
  mode: z.enum(SHIFT_MODES),
  lineId: z.string().uuid().nullable().optional(),
  counterpartyId: z.string().uuid().nullable().optional(),
  /**
   * Whose numbers this shift's boxes carry. Deliberately NOT derived from
   * `counterpartyId` -- that field answers "who is this for", this one
   * answers "whose numbers" -- see the field comment on the `shifts` table.
   * Omitted/null means the tenant's own organisation.
   */
  ssccIssuerCounterpartyId: z.string().uuid().nullable().optional(),
  /**
   * Omitted snapshots the organisation's current default. Explicit null
   * opts out; aggregation-mode validation then rejects the null snapshot.
   */
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
  ssccIssuerCounterpartyId: z.string().uuid().nullable().optional(),
  /** Updates the existing snapshot only when explicitly present. */
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
  /** Human-readable immutable number, e.g. `AUG26-003` (`/S` = station-created). */
  number: string;
  status: ShiftStatus;
  mode: ShiftMode;
  productId: string;
  productName: string | null;
  image?: ProductImageDescriptor | null;
  lineId: string | null;
  lineName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
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
  /** Station close authority, computed from station participation. */
  stationCloseAccess?: StationCloseAccess;
}

/** GET /shifts response. */
export interface ListShiftsResponseDto {
  items: ShiftDto[];
}

/** GET /shifts/planning-config response — the operations-readable planning subset only. */
export interface ShiftPlanningConfigDto {
  defaultBoxLabelTemplateId: string | null;
}

/**
 * Box-template summary exposed to station credentials. Deliberately excludes
 * the template `spec`: the station only ever receives a spec through the
 * shift bundle after the shift snapshot exists.
 */
export interface ShiftBoxLabelTemplateOptionDto {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: LabelTemplateSpec["dpi"];
  language: LabelTemplateSpec["language"];
}

/**
 * GET /shifts/box-label-templates response. The organisation default (when
 * set) is the first item; the rest follow ordered by name.
 */
export interface ShiftBoxLabelTemplatesDto {
  items: ShiftBoxLabelTemplateOptionDto[];
  defaultBoxLabelTemplateId: string | null;
}

/** Legacy fields retained only on station bundles during a rolling deployment. */
export type StationBundleProductDto = ProductDto & {
  defaultLabelTemplateId: null;
};

/** Legacy fields retained only on station bundles during a rolling deployment. */
export type StationBundleShiftDto = ShiftDto & {
  labelTemplateId: null;
  labelTemplateName: null;
};

/** GET /shifts/:id/bundle response — everything the station downloads offline. */
export interface ShiftBundleDto {
  shift: StationBundleShiftDto;
  product: StationBundleProductDto;
  /** Retired item-label compatibility slot. Current servers always serialize null. */
  labelTemplate: null;
  /**
   * The BOX label's own template (CodeRabbit PR33 review, Finding 3),
   * resolved from `shift.boxLabelTemplateId`. Null exactly when that snapshot
   * is null or no longer resolves to a template this tenant owns; it never
   * falls back to the retired item-label compatibility slot.
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
  /**
   * `fromSerial` of every block this device was handed and that has since
   * been revoked by an admin reseeding the counter. The station deletes the
   * matching `sscc_pool` rows (`dropRanges`) before applying `sscc` above --
   * without that, its `burnSerial` would keep draining the revoked lower
   * range and the reseeded number would never reach a label.
   *
   * Always present, `[]` when there is nothing to drop (including every
   * reference-only bundle, which never touches allocation state at all).
   */
  ssccRevokedFrom: number[];
}

/**
 * GET /shifts/:id/reference-bundle response. It carries only mirrored
 * reference data and can never allocate or reconcile an SSCC block.
 */
export type ShiftReferenceBundleDto = Omit<ShiftBundleDto, "sscc"> & { sscc: null };
