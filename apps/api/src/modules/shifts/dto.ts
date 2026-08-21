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

/** PostgreSQL-compatible civil day in the `date` column's string mode. */
function civilDateSchema(field: "plannedDate" | "productionDate") {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD`)
    .refine((value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (year < 1 || year > 9999) return false;
      const parsed = new Date(0);
      parsed.setUTCFullYear(year, month - 1, day);
      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
      );
    }, `${field} must be a real calendar date`);
}

const plannedDateSchema = civilDateSchema("plannedDate");
const productionDateSchema = civilDateSchema("productionDate");

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
  productionDate: productionDateSchema.nullable().optional(),
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
  productionDate: productionDateSchema.nullable().optional(),
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
  /** Short operator-facing product name; null = use `productName`. */
  productPrintName: string | null;
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
  productionDate: string | null;
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

export const productionDateOpenApiSchema = {
  type: "string",
  format: "date",
  nullable: true,
  description: "Declared production date; null keeps legacy date fallback behavior",
};

const nullableUuidOpenApiSchema = { type: "string", format: "uuid", nullable: true };
const nullablePositiveIntegerOpenApiSchema = { type: "integer", minimum: 1, nullable: true };
const nullableDateOpenApiSchema = { type: "string", format: "date", nullable: true };
const nullableDateTimeOpenApiSchema = { type: "string", format: "date-time", nullable: true };

export const createShiftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "mode"],
  properties: {
    productId: { type: "string", format: "uuid" },
    mode: { type: "string", enum: [...SHIFT_MODES] },
    lineId: nullableUuidOpenApiSchema,
    counterpartyId: nullableUuidOpenApiSchema,
    ssccIssuerCounterpartyId: nullableUuidOpenApiSchema,
    boxLabelTemplateId: nullableUuidOpenApiSchema,
    plannedQty: nullablePositiveIntegerOpenApiSchema,
    plannedDate: nullableDateOpenApiSchema,
    productionDate: productionDateOpenApiSchema,
    boxCapacity: nullablePositiveIntegerOpenApiSchema,
    palletCapacity: nullablePositiveIntegerOpenApiSchema,
    palletsEnabled: { type: "boolean" },
  },
};

export const updateShiftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    mode: { type: "string", enum: [...SHIFT_MODES] },
    lineId: nullableUuidOpenApiSchema,
    counterpartyId: nullableUuidOpenApiSchema,
    ssccIssuerCounterpartyId: nullableUuidOpenApiSchema,
    boxLabelTemplateId: nullableUuidOpenApiSchema,
    plannedQty: nullablePositiveIntegerOpenApiSchema,
    plannedDate: nullableDateOpenApiSchema,
    productionDate: productionDateOpenApiSchema,
    boxCapacity: nullablePositiveIntegerOpenApiSchema,
    palletCapacity: nullablePositiveIntegerOpenApiSchema,
    palletsEnabled: { type: "boolean" },
  },
};

const productImageOpenApiSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["checksum", "contentType", "byteSize", "width", "height"],
  properties: {
    checksum: { type: "string" },
    contentType: { type: "string", enum: ["image/webp"] },
    byteSize: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 0 },
    height: { type: "integer", minimum: 0 },
  },
};

const stationCloseAccessOpenApiSchema = {
  type: "object",
  oneOf: [
    {
      additionalProperties: false,
      required: ["kind", "ownerDeviceId"],
      properties: {
        kind: { type: "string", enum: ["single_device"] },
        ownerDeviceId: { type: "string", format: "uuid" },
      },
    },
    {
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", enum: ["admin_only"] } },
    },
  ],
};

const shiftRequiredFields = [
  "id",
  "number",
  "status",
  "mode",
  "productId",
  "productName",
  "productPrintName",
  "lineId",
  "lineName",
  "counterpartyId",
  "counterpartyName",
  "ssccIssuerCounterpartyId",
  "boxLabelTemplateId",
  "plannedQty",
  "plannedDate",
  "productionDate",
  "boxCapacity",
  "palletCapacity",
  "palletsEnabled",
  "createdFrom",
  "openedAt",
  "closedAt",
  "closeReason",
  "lateDataAt",
  "createdAt",
];

export const shiftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: shiftRequiredFields,
  properties: {
    id: { type: "string", format: "uuid" },
    number: { type: "string" },
    status: { type: "string", enum: [...SHIFT_STATUSES] },
    mode: { type: "string", enum: [...SHIFT_MODES] },
    productId: { type: "string", format: "uuid" },
    productName: { type: "string", nullable: true },
    productPrintName: { type: "string", nullable: true },
    image: productImageOpenApiSchema,
    lineId: nullableUuidOpenApiSchema,
    lineName: { type: "string", nullable: true },
    counterpartyId: nullableUuidOpenApiSchema,
    counterpartyName: { type: "string", nullable: true },
    ssccIssuerCounterpartyId: nullableUuidOpenApiSchema,
    boxLabelTemplateId: nullableUuidOpenApiSchema,
    plannedQty: nullablePositiveIntegerOpenApiSchema,
    plannedDate: nullableDateOpenApiSchema,
    productionDate: productionDateOpenApiSchema,
    boxCapacity: nullablePositiveIntegerOpenApiSchema,
    palletCapacity: nullablePositiveIntegerOpenApiSchema,
    palletsEnabled: { type: "boolean" },
    createdFrom: { type: "string", enum: ["admin", "station"] },
    openedAt: nullableDateTimeOpenApiSchema,
    closedAt: nullableDateTimeOpenApiSchema,
    closeReason: { type: "string", nullable: true },
    lateDataAt: nullableDateTimeOpenApiSchema,
    createdAt: { type: "string", format: "date-time" },
    stationCloseAccess: stationCloseAccessOpenApiSchema,
  },
};

export const listShiftsOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: shiftOpenApiSchema } },
};

const stationBundleShiftOpenApiSchema = {
  ...shiftOpenApiSchema,
  required: [...shiftRequiredFields, "image", "labelTemplateId", "labelTemplateName"],
  properties: {
    ...shiftOpenApiSchema.properties,
    labelTemplateId: { type: "string", nullable: true, enum: [null] },
    labelTemplateName: { type: "string", nullable: true, enum: [null] },
  },
};

const stationBundleProductOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "gtin14",
    "name",
    "productGroup",
    "boxCapacity",
    "palletCapacity",
    "status",
    "defaultCounterpartyId",
    "defaultLabelTemplateId",
    "unitPrice",
    "printName",
    "egaisCode",
    "shelfLifeDays",
    "externalRef",
    "createdAt",
    "image",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    gtin14: { type: "string" },
    name: { type: "string" },
    productGroup: { type: "string", nullable: true },
    boxCapacity: nullablePositiveIntegerOpenApiSchema,
    palletCapacity: nullablePositiveIntegerOpenApiSchema,
    status: { type: "string", enum: ["draft", "active"] },
    defaultCounterpartyId: nullableUuidOpenApiSchema,
    defaultLabelTemplateId: { type: "string", nullable: true, enum: [null] },
    unitPrice: { type: "string", nullable: true },
    printName: { type: "string", nullable: true },
    egaisCode: { type: "string", nullable: true },
    shelfLifeDays: nullablePositiveIntegerOpenApiSchema,
    externalRef: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    image: productImageOpenApiSchema,
  },
};

const boxLabelTemplateOpenApiSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["id", "name", "spec"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    spec: { type: "object", additionalProperties: true },
  },
};

const operatorMirrorOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operatorId", "name", "login", "role", "pinHash", "badgeHash", "active"],
  properties: {
    operatorId: { type: "string", format: "uuid" },
    name: { type: "string" },
    login: { type: "string" },
    role: { type: "string" },
    pinHash: { type: "string" },
    badgeHash: { type: "string", nullable: true },
    active: { type: "boolean" },
  },
};

const ssccBundleOpenApiSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["issuerPrefix", "extensionDigit", "fromSerial", "toSerial", "consumedThroughSerial"],
  properties: {
    issuerPrefix: { type: "string" },
    extensionDigit: { type: "integer", minimum: 0, maximum: 9 },
    fromSerial: { type: "integer", minimum: 0 },
    toSerial: { type: "integer", minimum: 0 },
    consumedThroughSerial: { type: "integer", minimum: 0, nullable: true },
  },
};

const shiftBundleRequiredFields = [
  "shift",
  "product",
  "labelTemplate",
  "boxLabelTemplate",
  "counterpartyGln",
  "operators",
  "sscc",
  "ssccRevokedFrom",
];

export const shiftBundleOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: shiftBundleRequiredFields,
  properties: {
    shift: stationBundleShiftOpenApiSchema,
    product: stationBundleProductOpenApiSchema,
    labelTemplate: { type: "string", nullable: true, enum: [null] },
    boxLabelTemplate: boxLabelTemplateOpenApiSchema,
    counterpartyGln: { type: "string", nullable: true },
    operators: { type: "array", items: operatorMirrorOpenApiSchema },
    sscc: ssccBundleOpenApiSchema,
    ssccRevokedFrom: { type: "array", items: { type: "integer", minimum: 0 } },
  },
};

export const shiftReferenceBundleOpenApiSchema = {
  ...shiftBundleOpenApiSchema,
  properties: {
    ...shiftBundleOpenApiSchema.properties,
    sscc: { type: "object", nullable: true, enum: [null] },
  },
};
