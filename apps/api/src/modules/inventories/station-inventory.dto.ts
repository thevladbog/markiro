import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

import { LABEL_FIELDS, parseLabelTemplate, type LabelTemplateSpec } from "@markiro/domain";

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
  readonly combinedDigest: string;
  /** All six source-status rows, not only expected inventory stock. */
  readonly codeCount: number;
  readonly productId: string;
  readonly productName: string;
  readonly gtin14: string;
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
    combinedDigest: z.string().regex(/^[0-9a-f]{64}$/),
    codeCount: z.number().int().nonnegative(),
    productId: z.uuid(),
    productName: z.string(),
    gtin14: z.string().regex(/^[0-9]{14}$/),
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
    "combinedDigest",
    "codeCount",
    "productId",
    "productName",
    "gtin14",
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
    combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    codeCount: { type: "integer", minimum: 0 },
    productId: { type: "string", format: "uuid" },
    productName: { type: "string" },
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
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
