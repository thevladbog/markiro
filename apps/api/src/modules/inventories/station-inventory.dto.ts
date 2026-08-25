import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

import {
  INVENTORY_CHZ_STATUSES,
  INVENTORY_PROGRESS_CURSOR_PATTERN,
  inventoryEventBatchSchema,
  inventoryProgressCursorSchema,
  LABEL_FIELDS,
  parseLabelTemplate,
  type InventoryEventBatch,
  type InventoryEventBatchResponse,
  type InventoryProgressPage,
  type LabelTemplateSpec,
} from "@markiro/domain";

import { inventoryCivilDateSchema, type InventoryMode } from "./dto";

/** Frozen v1 page size for immutable inventory snapshot code pages. */
export const STATION_INVENTORY_CODE_PAGE_SIZE = 200;
/** Frozen v1 maximum number of inventory events accepted in one Station batch. */
export const STATION_INVENTORY_EVENT_BATCH_SIZE = 100;
/** Frozen v1 page size for cursor-based cross-terminal progress deltas. */
export const STATION_INVENTORY_PROGRESS_PAGE_SIZE = 200;

export const STATION_INVENTORY_LIMITS = {
  codePageSize: STATION_INVENTORY_CODE_PAGE_SIZE,
  eventBatchSize: STATION_INVENTORY_EVENT_BATCH_SIZE,
  progressPageSize: STATION_INVENTORY_PROGRESS_PAGE_SIZE,
} as const;

export const stationInventoryEventBatchSchema = inventoryEventBatchSchema;
export type StationInventoryEventBatchDto = InventoryEventBatch;
export type StationInventoryEventBatchResponseDto = InventoryEventBatchResponse;

export const stationInventoryProgressQuerySchema = z.strictObject({
  cursor: inventoryProgressCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(STATION_INVENTORY_PROGRESS_PAGE_SIZE).default(200),
});
export type StationInventoryProgressQueryDto = z.infer<typeof stationInventoryProgressQuerySchema>;
export type StationInventoryProgressDto = InventoryProgressPage;

export const leaveStationInventorySchema = z.strictObject({
  pendingEventCount: z.literal(0),
  openBoxCount: z.literal(0),
});
export type LeaveStationInventoryDto = z.infer<typeof leaveStationInventorySchema>;
export interface LeaveStationInventoryResponseDto {
  readonly outcome: "left";
}

const CANONICAL_UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const inventoryEventOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "eventId",
    "deviceSequence",
    "operatorId",
    "scannedAt",
    "kind",
    "normalizedIdentity",
    "codeHash",
    "canonicalRaw",
    "activeProductionDate",
    "localVerdict",
  ],
  properties: {
    eventId: {
      type: "string",
      format: "uuid",
      pattern: CANONICAL_UUID_PATTERN,
    },
    deviceSequence: { type: "integer", minimum: 1 },
    operatorId: {
      type: "string",
      format: "uuid",
      pattern: CANONICAL_UUID_PATTERN,
    },
    scannedAt: { type: "string", format: "date-time" },
    kind: { type: "string", enum: ["item", "known_box", "old_box"] },
    normalizedIdentity: { type: "string", minLength: 1, maxLength: 1024 },
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
    canonicalRaw: { type: "string", minLength: 1, maxLength: 2048, nullable: true },
    activeProductionDate: { type: "string", format: "date", nullable: true },
    localVerdict: {
      type: "string",
      enum: ["expected", "protected", "known-ineligible", "unknown", "duplicate"],
    },
  },
};

const inventoryClaimWinnerOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["codeHash", "eventId", "deviceId", "scannedAt"],
  properties: {
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    eventId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    deviceId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    scannedAt: { type: "string", format: "date-time" },
  },
};

const inventoryEventClaimOutcomeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["codeHash", "status", "winner"],
  properties: {
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    status: { type: "string", enum: ["claimed", "duplicate"] },
    winner: inventoryClaimWinnerOpenApiSchema,
  },
};

const inventoryEventOutcomeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "status", "reasonCode", "claimedCount", "conflictCount", "claims"],
  properties: {
    eventId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    status: {
      type: "string",
      enum: ["applied", "replay", "duplicate", "rejected", "quarantined"],
    },
    reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    claimedCount: { type: "integer", minimum: 0 },
    conflictCount: { type: "integer", minimum: 0 },
    claims: {
      type: "array",
      maxItems: 10_000,
      items: inventoryEventClaimOutcomeOpenApiSchema,
    },
  },
};

export const stationInventoryEventBatchOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "batchId",
    "payloadDigest",
    "snapshotId",
    "snapshotRevision",
    "sequenceCeiling",
    "pendingEventCount",
    "openBoxCount",
    "events",
  ],
  properties: {
    batchId: { type: "string", minLength: 1, maxLength: 128 },
    payloadDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    snapshotId: {
      type: "string",
      format: "uuid",
      pattern: CANONICAL_UUID_PATTERN,
    },
    snapshotRevision: { type: "integer", enum: [1] },
    sequenceCeiling: { type: "integer", minimum: 1 },
    pendingEventCount: { type: "integer", minimum: 0 },
    openBoxCount: { type: "integer", minimum: 0 },
    events: { type: "array", minItems: 1, maxItems: 100, items: inventoryEventOpenApiSchema },
  },
};

export const stationInventoryEventBatchResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "inventoryId",
    "snapshotId",
    "snapshotRevision",
    "batchId",
    "payloadDigest",
    "sequenceCeiling",
    "resultRevision",
    "outcomes",
  ],
  properties: {
    inventoryId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    snapshotId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    snapshotRevision: { type: "integer", enum: [1] },
    batchId: { type: "string" },
    payloadDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    sequenceCeiling: { type: "integer", minimum: 1 },
    resultRevision: { type: "integer", minimum: 0 },
    outcomes: {
      type: "array",
      minItems: 1,
      maxItems: STATION_INVENTORY_EVENT_BATCH_SIZE,
      items: inventoryEventOutcomeOpenApiSchema,
    },
  },
};

const inventoryProgressChangeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "kind",
    "codeHash",
    "classification",
    "observedProductionDate",
    "winner",
    "correctedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    revision: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: ["claim", "correction"] },
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    classification: {
      type: "string",
      enum: ["expected", "protected", "ineligible", "unknown", "voided"],
    },
    observedProductionDate: { type: "string", format: "date", nullable: true },
    winner: { ...inventoryClaimWinnerOpenApiSchema, nullable: true },
    correctedAt: { type: "string", format: "date-time" },
  },
};

export const stationInventoryProgressOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "inventoryId",
    "snapshotId",
    "snapshotRevision",
    "cursor",
    "resultRevision",
    "items",
    "nextCursor",
  ],
  properties: {
    inventoryId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    snapshotId: { type: "string", format: "uuid", pattern: CANONICAL_UUID_PATTERN },
    snapshotRevision: { type: "integer", enum: [1] },
    cursor: {
      type: "string",
      pattern: INVENTORY_PROGRESS_CURSOR_PATTERN,
      nullable: true,
    },
    resultRevision: { type: "integer", minimum: 0 },
    items: {
      type: "array",
      maxItems: STATION_INVENTORY_PROGRESS_PAGE_SIZE,
      items: inventoryProgressChangeOpenApiSchema,
    },
    nextCursor: {
      type: "string",
      pattern: INVENTORY_PROGRESS_CURSOR_PATTERN,
      nullable: true,
    },
  },
};

export const leaveStationInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["pendingEventCount", "openBoxCount"],
  properties: {
    pendingEventCount: { type: "integer", enum: [0] },
    openBoxCount: { type: "integer", enum: [0] },
  },
};

export const leaveStationInventoryResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: { outcome: { type: "string", enum: ["left"] } },
};

export interface StationInventoryLabelTemplateDescriptor {
  readonly id: string;
  readonly name: string;
  readonly spec: LabelTemplateSpec;
}

/**
 * Frozen Plan 2 input contract returned by the cabinet start transition.
 * Future station work may add optional fields, but cannot reinterpret these
 * required v1 fields, the inclusive civil-date range, or snapshot digest/count.
 */
export interface StationInventoryManifest {
  readonly inventoryId: string;
  readonly inventoryNumber: string;
  readonly snapshotId: string;
  readonly snapshotRevision: 1;
  /** Server-owned immutable ordering/fixation fact for rollback prevention. */
  readonly snapshotFixedAt: string;
  readonly combinedDigest: string;
  /** SHA-256 over every immutable snapshot-code row in code-hash order. */
  readonly contentDigest: string;
  /** All six source-status rows, not only expected inventory stock. */
  readonly codeCount: number;
  readonly productId: string;
  readonly productName: string;
  readonly gtin14: string;
  /** Frozen product aggregation capacity used by the offline repack reducer. */
  readonly boxCapacity: number;
  readonly mode: InventoryMode;
  readonly lineId: string;
  readonly lineName: string;
  /** Inclusive lower bound, represented as a tenant civil date. */
  readonly productionDateFrom: string;
  /** Inclusive upper bound, represented as a tenant civil date. */
  readonly productionDateTo: string;
  readonly boxLabelTemplate: StationInventoryLabelTemplateDescriptor | null;
  readonly limits: typeof STATION_INVENTORY_LIMITS;
}

export type LegacyStationInventoryManifest = Omit<
  StationInventoryManifest,
  "snapshotFixedAt" | "contentDigest"
>;

const storedLabelElementBaseShape = {
  id: z.string().min(1),
  xMm: z.number(),
  yMm: z.number(),
};

const storedLabelTextShape = {
  fontSizePt: z.number().min(4).max(72),
  bold: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  maxWidthMm: z.number().positive().optional(),
  maxLines: z.number().int().min(1).max(16).optional(),
};

const storedLabelElementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...storedLabelElementBaseShape,
    kind: z.literal("text"),
    text: z.string(),
    ...storedLabelTextShape,
  }),
  z.strictObject({
    ...storedLabelElementBaseShape,
    kind: z.literal("field"),
    field: z.enum(LABEL_FIELDS),
    ...storedLabelTextShape,
  }),
  z.strictObject({
    ...storedLabelElementBaseShape,
    kind: z.literal("barcode"),
    format: z.enum(["datamatrix", "code128", "ean13", "qr"]),
    data: z.union([
      z.enum(LABEL_FIELDS),
      z.strictObject({
        literal: z.string(),
      }),
    ]),
    sizeMm: z.number().positive(),
    moduleWidthMm: z.number().positive().optional(),
  }),
  z.strictObject({
    ...storedLabelElementBaseShape,
    kind: z.literal("line"),
    x2Mm: z.number(),
    y2Mm: z.number(),
    thicknessMm: z.number().positive(),
  }),
  z.strictObject({
    ...storedLabelElementBaseShape,
    kind: z.literal("box"),
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
    thicknessMm: z.number().positive(),
  }),
]);

const closedStoredLabelTemplateSpecSchema = z.strictObject({
  widthMm: z.number().min(10).max(300),
  heightMm: z.number().min(10).max(300),
  dpi: z.union([z.literal(203), z.literal(300)]),
  language: z.enum(["zpl", "tspl"]),
  elements: z.array(storedLabelElementSchema),
});

const storedLabelTemplateSpecSchema = closedStoredLabelTemplateSpecSchema.transform(
  (value, context) => {
    try {
      return parseLabelTemplate(value);
    } catch {
      context.addIssue({ code: "custom", message: "invalid label template spec" });
      return z.NEVER;
    }
  },
);

const storedStationInventoryManifestSchema = z
  .object({
    inventoryId: z.uuid(),
    inventoryNumber: z.string(),
    snapshotId: z.uuid(),
    snapshotRevision: z.literal(1),
    snapshotFixedAt: z.iso.datetime(),
    combinedDigest: z.string().regex(/^[0-9a-f]{64}$/),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    codeCount: z.number().int().nonnegative(),
    productId: z.uuid(),
    productName: z.string(),
    gtin14: z.string().regex(/^[0-9]{14}$/),
    boxCapacity: z.number().int().positive(),
    mode: z.enum(["check", "repack"]),
    lineId: z.uuid(),
    lineName: z.string(),
    productionDateFrom: inventoryCivilDateSchema("productionDateFrom"),
    productionDateTo: inventoryCivilDateSchema("productionDateTo"),
    boxLabelTemplate: z
      .object({
        id: z.uuid(),
        name: z.string(),
        spec: storedLabelTemplateSpecSchema,
      })
      .strict()
      .nullable(),
    limits: z
      .object({
        codePageSize: z.literal(STATION_INVENTORY_CODE_PAGE_SIZE),
        eventBatchSize: z.literal(STATION_INVENTORY_EVENT_BATCH_SIZE),
        progressPageSize: z.literal(STATION_INVENTORY_PROGRESS_PAGE_SIZE),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.productionDateFrom > manifest.productionDateTo) {
      context.addIssue({
        code: "custom",
        message: "production date range is inverted",
        path: ["productionDateTo"],
      });
    }
    if (
      (manifest.mode === "check" && manifest.boxLabelTemplate !== null) ||
      (manifest.mode === "repack" && manifest.boxLabelTemplate === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "mode and box label template are inconsistent",
        path: ["boxLabelTemplate"],
      });
    }
  });

/** Parses the durable v1 JSON without exposing validation internals to callers. */
export function parseStationInventoryManifest(value: unknown): StationInventoryManifest {
  const result = storedStationInventoryManifestSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid stored station inventory manifest");
  return result.data;
}

/**
 * Parses only the exact pre-proof durable shape. It is intentionally separate
 * from the network parser: proof fields may be reconstructed only from trusted
 * immutable snapshot rows, never supplied by an untrusted caller.
 */
export function parseLegacyStationInventoryManifest(
  value: unknown,
): LegacyStationInventoryManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid legacy stored station inventory manifest");
  }
  const record = value as Record<string, unknown>;
  if ("snapshotFixedAt" in record || "contentDigest" in record) {
    throw new Error("Invalid legacy stored station inventory manifest");
  }
  const upgraded = parseStationInventoryManifest({
    ...record,
    snapshotFixedAt: "2000-01-01T00:00:00.000Z",
    contentDigest: "0".repeat(64),
  });
  const {
    snapshotFixedAt: ignoredSnapshotFixedAt,
    contentDigest: ignoredContentDigest,
    ...legacy
  } = upgraded;
  void ignoredSnapshotFixedAt;
  void ignoredContentDigest;
  return legacy;
}

const labelElementBaseProperties = {
  id: { type: "string", minLength: 1 },
  xMm: { type: "number" },
  yMm: { type: "number" },
} satisfies Record<string, SchemaObject>;

const labelTextProperties = {
  fontSizePt: { type: "number", minimum: 4, maximum: 72 },
  bold: { type: "boolean" },
  align: { type: "string", enum: ["left", "center", "right"] },
  maxWidthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
  maxLines: { type: "integer", minimum: 1, maximum: 16 },
} satisfies Record<string, SchemaObject>;

const labelElementOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "xMm", "yMm", "text", "fontSizePt"],
      properties: {
        ...labelElementBaseProperties,
        kind: { type: "string", enum: ["text"] },
        text: { type: "string" },
        ...labelTextProperties,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "xMm", "yMm", "field", "fontSizePt"],
      properties: {
        ...labelElementBaseProperties,
        kind: { type: "string", enum: ["field"] },
        field: { type: "string", enum: [...LABEL_FIELDS] },
        ...labelTextProperties,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "xMm", "yMm", "format", "data", "sizeMm"],
      properties: {
        ...labelElementBaseProperties,
        kind: { type: "string", enum: ["barcode"] },
        format: { type: "string", enum: ["datamatrix", "code128", "ean13", "qr"] },
        data: {
          oneOf: [
            { type: "string", enum: [...LABEL_FIELDS] },
            {
              type: "object",
              additionalProperties: false,
              required: ["literal"],
              properties: { literal: { type: "string" } },
            },
          ],
        },
        sizeMm: { type: "number", minimum: 0, exclusiveMinimum: true },
        moduleWidthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "xMm", "yMm", "x2Mm", "y2Mm", "thicknessMm"],
      properties: {
        ...labelElementBaseProperties,
        kind: { type: "string", enum: ["line"] },
        x2Mm: { type: "number" },
        y2Mm: { type: "number" },
        thicknessMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "xMm", "yMm", "widthMm", "heightMm", "thicknessMm"],
      properties: {
        ...labelElementBaseProperties,
        kind: { type: "string", enum: ["box"] },
        widthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
        heightMm: { type: "number", minimum: 0, exclusiveMinimum: true },
        thicknessMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      },
    },
  ],
};

export const stationInventoryLabelTemplateSpecOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["widthMm", "heightMm", "dpi", "language", "elements"],
  properties: {
    widthMm: { type: "number", minimum: 10, maximum: 300 },
    heightMm: { type: "number", minimum: 10, maximum: 300 },
    dpi: { type: "integer", enum: [203, 300] },
    language: { type: "string", enum: ["zpl", "tspl"] },
    elements: { type: "array", items: labelElementOpenApiSchema },
  },
};

export const stationInventoryManifestOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "inventoryId",
    "inventoryNumber",
    "snapshotId",
    "snapshotRevision",
    "snapshotFixedAt",
    "combinedDigest",
    "contentDigest",
    "codeCount",
    "productId",
    "productName",
    "gtin14",
    "boxCapacity",
    "mode",
    "lineId",
    "lineName",
    "productionDateFrom",
    "productionDateTo",
    "boxLabelTemplate",
    "limits",
  ],
  properties: {
    inventoryId: { type: "string", format: "uuid" },
    inventoryNumber: { type: "string" },
    snapshotId: { type: "string", format: "uuid" },
    snapshotRevision: { type: "integer", minimum: 1, maximum: 1 },
    snapshotFixedAt: { type: "string", format: "date-time" },
    combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    contentDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    codeCount: { type: "integer", minimum: 0 },
    productId: { type: "string", format: "uuid" },
    productName: { type: "string" },
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    boxCapacity: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["check", "repack"] },
    lineId: { type: "string", format: "uuid" },
    lineName: { type: "string" },
    productionDateFrom: {
      type: "string",
      format: "date",
      description: "Inclusive tenant civil-date lower bound.",
    },
    productionDateTo: {
      type: "string",
      format: "date",
      description: "Inclusive tenant civil-date upper bound.",
    },
    boxLabelTemplate: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["id", "name", "spec"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        spec: stationInventoryLabelTemplateSpecOpenApiSchema,
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["codePageSize", "eventBatchSize", "progressPageSize"],
      properties: {
        codePageSize: { type: "integer", enum: [STATION_INVENTORY_CODE_PAGE_SIZE] },
        eventBatchSize: { type: "integer", enum: [STATION_INVENTORY_EVENT_BATCH_SIZE] },
        progressPageSize: { type: "integer", enum: [STATION_INVENTORY_PROGRESS_PAGE_SIZE] },
      },
    },
  },
};

const inventoryTaskBarcodePrefix = "markiro:inventory:v1:";

export function formatInventoryTaskBarcode(inventoryId: string): string {
  return `${inventoryTaskBarcodePrefix}${inventoryId}`;
}

export function parseInventoryTaskBarcode(barcode: string): string | null {
  if (!barcode.startsWith(inventoryTaskBarcodePrefix)) return null;
  const parsed = z.uuid().safeParse(barcode.slice(inventoryTaskBarcodePrefix.length));
  return parsed.success ? parsed.data : null;
}

export interface StationInventoryTaskDto {
  inventoryId: string;
  inventoryNumber: string;
  productName: string;
  mode: InventoryMode;
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
}

export interface StationInventoryTaskListDto {
  items: StationInventoryTaskDto[];
}

export interface ResolveStationInventoryBarcodeDto {
  barcode: string;
}

export interface ResolveStationInventoryBarcodeResponseDto {
  task: StationInventoryTaskDto;
  deviceLineId: string | null;
  requiresDifferentLineConfirmation: boolean;
}

export const resolveStationInventoryBarcodeSchema = z.strictObject({
  barcode: z.string().max(128),
});

export interface JoinStationInventoryDto {
  operatorId: string;
  barcode?: string;
  confirmDifferentLine?: boolean;
}

export const joinStationInventorySchema = z.strictObject({
  operatorId: z.uuid(),
  barcode: z.string().max(128).optional(),
  confirmDifferentLine: z.boolean().optional(),
});

export interface StationInventorySsccBlockDto {
  allocationOrder: number;
  issuerPrefix: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
  consumedThroughSerial: number | null;
}

export interface StationInventoryRevokedSsccBlockDto {
  allocationOrder: number;
  fromSerial: number;
  toSerial: number;
}

export interface StationInventoryBundleManifestDto extends StationInventoryManifest {
  sscc: StationInventorySsccBlockDto | null;
  ssccRevokedFrom: number[];
  ssccRevokedBlocks: StationInventoryRevokedSsccBlockDto[];
}

export interface StationInventoryBundleCodeDto {
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
  sourceStatus: (typeof INVENTORY_CHZ_STATUSES)[number];
  sourceState: string | null;
  sourceProductionDate: string | null;
  parentSscc: string | null;
  expected: boolean;
  protected: boolean;
}

export interface StationInventoryBundleCodesDto {
  snapshotId: string;
  snapshotRevision: 1;
  snapshotFixedAt: string;
  combinedDigest: string;
  contentDigest: string;
  cursor: string | null;
  items: StationInventoryBundleCodeDto[];
  nextCursor: string | null;
  pageDigest: string;
}

export const stationInventoryBundleCodesQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(STATION_INVENTORY_CODE_PAGE_SIZE)
    .default(STATION_INVENTORY_CODE_PAGE_SIZE),
});

export type StationInventoryBundleCodesQueryDto = z.infer<
  typeof stationInventoryBundleCodesQuerySchema
>;

const stationInventoryTaskOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "inventoryId",
    "inventoryNumber",
    "productName",
    "mode",
    "lineId",
    "lineName",
    "productionDateFrom",
    "productionDateTo",
  ],
  properties: {
    inventoryId: { type: "string", format: "uuid" },
    inventoryNumber: { type: "string" },
    productName: { type: "string" },
    mode: { type: "string", enum: ["check", "repack"] },
    lineId: { type: "string", format: "uuid" },
    lineName: { type: "string" },
    productionDateFrom: { type: "string", format: "date" },
    productionDateTo: { type: "string", format: "date" },
  },
};

export const stationInventoryTaskListOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: stationInventoryTaskOpenApiSchema } },
};

export const resolveStationInventoryBarcodeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["barcode"],
  properties: { barcode: { type: "string", maxLength: 128 } },
};

export const resolveStationInventoryBarcodeResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["task", "deviceLineId", "requiresDifferentLineConfirmation"],
  properties: {
    task: stationInventoryTaskOpenApiSchema,
    deviceLineId: { type: "string", format: "uuid", nullable: true },
    requiresDifferentLineConfirmation: { type: "boolean" },
  },
};

export const joinStationInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["operatorId"],
  properties: {
    operatorId: { type: "string", format: "uuid" },
    barcode: { type: "string", maxLength: 128 },
    confirmDifferentLine: { type: "boolean" },
  },
};

const stationInventorySsccOpenApiSchema: SchemaObject = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: [
    "allocationOrder",
    "issuerPrefix",
    "extensionDigit",
    "fromSerial",
    "toSerial",
    "consumedThroughSerial",
  ],
  properties: {
    allocationOrder: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    issuerPrefix: { type: "string", pattern: "^[0-9]{9}$" },
    extensionDigit: { type: "integer", minimum: 0, maximum: 9 },
    fromSerial: { type: "integer", minimum: 0 },
    toSerial: { type: "integer", minimum: 0 },
    consumedThroughSerial: { type: "integer", minimum: 0, nullable: true },
  },
};

const stationInventoryRevokedSsccBlockOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["allocationOrder", "fromSerial", "toSerial"],
  properties: {
    allocationOrder: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    fromSerial: { type: "integer", minimum: 0 },
    toSerial: { type: "integer", minimum: 0 },
  },
};

export const stationInventoryBundleManifestOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    ...(stationInventoryManifestOpenApiSchema.required ?? []),
    "sscc",
    "ssccRevokedFrom",
    "ssccRevokedBlocks",
  ],
  properties: {
    ...(stationInventoryManifestOpenApiSchema.properties ?? {}),
    sscc: stationInventorySsccOpenApiSchema,
    ssccRevokedFrom: { type: "array", items: { type: "integer", minimum: 0 } },
    ssccRevokedBlocks: {
      type: "array",
      items: stationInventoryRevokedSsccBlockOpenApiSchema,
    },
  },
};

const stationInventoryBundleCodeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "codeHash",
    "canonicalRaw",
    "gtin14",
    "serial",
    "sourceStatus",
    "sourceState",
    "sourceProductionDate",
    "parentSscc",
    "expected",
    "protected",
  ],
  properties: {
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    canonicalRaw: { type: "string", maxLength: 1024 },
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    serial: { type: "string", minLength: 1 },
    sourceStatus: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] },
    sourceState: { type: "string", nullable: true },
    sourceProductionDate: { type: "string", format: "date", nullable: true },
    parentSscc: { type: "string", pattern: "^[0-9]{18}$", nullable: true },
    expected: { type: "boolean" },
    protected: { type: "boolean" },
  },
};

export const stationInventoryBundleCodesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "snapshotId",
    "snapshotRevision",
    "snapshotFixedAt",
    "combinedDigest",
    "contentDigest",
    "cursor",
    "items",
    "nextCursor",
    "pageDigest",
  ],
  properties: {
    snapshotId: { type: "string", format: "uuid" },
    snapshotRevision: { type: "integer", minimum: 1, maximum: 1 },
    snapshotFixedAt: { type: "string", format: "date-time" },
    combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    contentDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    cursor: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
    items: { type: "array", items: stationInventoryBundleCodeOpenApiSchema },
    nextCursor: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
    pageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
};
