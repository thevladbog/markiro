import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

import { LABEL_FIELDS, parseLabelTemplate } from "../labels/model.js";
import { INVENTORY_CHZ_STATUSES } from "./status.js";

export const STATION_INVENTORY_BUNDLE_LIMITS = {
  codePageSize: 200,
  eventBatchSize: 100,
  progressPageSize: 200,
} as const;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const civilDateSchema = z.iso.date();

const labelElementBaseShape = {
  id: z.string().min(1),
  xMm: z.number(),
  yMm: z.number(),
};
const labelTextShape = {
  fontSizePt: z.number().min(4).max(72),
  bold: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  maxWidthMm: z.number().positive().optional(),
  maxLines: z.number().int().min(1).max(16).optional(),
};
const labelElementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...labelElementBaseShape,
    kind: z.literal("text"),
    text: z.string(),
    ...labelTextShape,
  }),
  z.strictObject({
    ...labelElementBaseShape,
    kind: z.literal("field"),
    field: z.enum(LABEL_FIELDS),
    ...labelTextShape,
  }),
  z.strictObject({
    ...labelElementBaseShape,
    kind: z.literal("barcode"),
    format: z.enum(["datamatrix", "code128", "ean13", "qr"]),
    data: z.union([z.enum(LABEL_FIELDS), z.strictObject({ literal: z.string() })]),
    sizeMm: z.number().positive(),
    moduleWidthMm: z.number().positive().optional(),
  }),
  z.strictObject({
    ...labelElementBaseShape,
    kind: z.literal("line"),
    x2Mm: z.number(),
    y2Mm: z.number(),
    thicknessMm: z.number().positive(),
  }),
  z.strictObject({
    ...labelElementBaseShape,
    kind: z.literal("box"),
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
    thicknessMm: z.number().positive(),
  }),
]);
const labelSpecSchema = z
  .strictObject({
    widthMm: z.number().min(10).max(300),
    heightMm: z.number().min(10).max(300),
    dpi: z.union([z.literal(203), z.literal(300)]),
    language: z.enum(["zpl", "tspl"]),
    elements: z.array(labelElementSchema),
  })
  .transform((value, context) => {
    try {
      return parseLabelTemplate(value);
    } catch {
      context.addIssue({ code: "custom", message: "invalid label template spec" });
      return z.NEVER;
    }
  });

export const stationInventoryBundleCodeSchema = z.strictObject({
  codeHash: digestSchema,
  canonicalRaw: z.string().min(1).max(1024),
  gtin14: z.string().regex(/^[0-9]{14}$/),
  serial: z.string().min(1),
  sourceStatus: z.enum(INVENTORY_CHZ_STATUSES),
  sourceState: z.string().nullable(),
  sourceProductionDate: civilDateSchema.nullable(),
  parentSscc: z
    .string()
    .regex(/^[0-9]{18}$/)
    .nullable(),
  expected: z.boolean(),
  protected: z.boolean(),
});

const immutableManifestShape = {
  inventoryId: z.uuid(),
  inventoryNumber: z.string().min(1),
  snapshotId: z.uuid(),
  snapshotRevision: z.literal(1),
  snapshotFixedAt: z.iso.datetime(),
  combinedDigest: digestSchema,
  contentDigest: digestSchema,
  codeCount: z.number().int().nonnegative(),
  productId: z.uuid(),
  productName: z.string().min(1),
  gtin14: z.string().regex(/^[0-9]{14}$/),
  boxCapacity: z.number().int().positive(),
  mode: z.enum(["check", "repack"]),
  lineId: z.uuid(),
  lineName: z.string().min(1),
  productionDateFrom: civilDateSchema,
  productionDateTo: civilDateSchema,
  boxLabelTemplate: z
    .strictObject({ id: z.uuid(), name: z.string().min(1), spec: labelSpecSchema })
    .nullable(),
  limits: z.strictObject({
    codePageSize: z.literal(STATION_INVENTORY_BUNDLE_LIMITS.codePageSize),
    eventBatchSize: z.literal(STATION_INVENTORY_BUNDLE_LIMITS.eventBatchSize),
    progressPageSize: z.literal(STATION_INVENTORY_BUNDLE_LIMITS.progressPageSize),
  }),
};

const ssccSchema = z
  .strictObject({
    allocationOrder: z.number().int().safe().positive(),
    issuerPrefix: z.string().regex(/^[0-9]{9}$/),
    extensionDigit: z.number().int().min(0).max(9),
    fromSerial: z.number().int().safe().nonnegative(),
    toSerial: z.number().int().safe().nonnegative(),
    consumedThroughSerial: z.number().int().safe().nonnegative().nullable(),
  })
  .superRefine((block, context) => {
    if (block.fromSerial > block.toSerial) {
      context.addIssue({ code: "custom", message: "SSCC range is inverted" });
    }
    if (
      block.consumedThroughSerial !== null &&
      (block.consumedThroughSerial < block.fromSerial ||
        block.consumedThroughSerial > block.toSerial)
    ) {
      context.addIssue({ code: "custom", message: "SSCC cursor is outside its range" });
    }
  });

const revokedSsccBlockSchema = z
  .strictObject({
    allocationOrder: z.number().int().safe().positive(),
    fromSerial: z.number().int().safe().nonnegative(),
    toSerial: z.number().int().safe().nonnegative(),
  })
  .refine((block) => block.fromSerial <= block.toSerial, {
    message: "SSCC revoked range is inverted",
  });

export const stationInventoryBundleManifestSchema = z
  .strictObject({
    ...immutableManifestShape,
    sscc: ssccSchema.nullable(),
    ssccRevokedFrom: z.array(z.number().int().safe().nonnegative()),
    ssccRevokedBlocks: z.array(revokedSsccBlockSchema),
  })
  .superRefine((manifest, context) => {
    if (manifest.productionDateFrom > manifest.productionDateTo) {
      context.addIssue({ code: "custom", message: "production date range is inverted" });
    }
    if (
      (manifest.mode === "check" &&
        (manifest.boxLabelTemplate !== null ||
          manifest.sscc !== null ||
          manifest.ssccRevokedFrom.length !== 0 ||
          manifest.ssccRevokedBlocks.length !== 0)) ||
      (manifest.mode === "repack" && (manifest.boxLabelTemplate === null || manifest.sscc === null))
    ) {
      context.addIssue({ code: "custom", message: "mode and repack facts are inconsistent" });
    }
    const uniqueRevocations = new Set(manifest.ssccRevokedFrom);
    const revokedOrders = new Set(manifest.ssccRevokedBlocks.map((block) => block.allocationOrder));
    if (
      uniqueRevocations.size !== manifest.ssccRevokedFrom.length ||
      manifest.ssccRevokedFrom.some(
        (value, index) => index > 0 && value <= manifest.ssccRevokedFrom[index - 1]!,
      ) ||
      (manifest.sscc !== null && uniqueRevocations.has(manifest.sscc.fromSerial))
    ) {
      context.addIssue({ code: "custom", message: "unsafe SSCC revocation list" });
    }
    if (
      revokedOrders.size !== manifest.ssccRevokedBlocks.length ||
      manifest.ssccRevokedBlocks.some(
        (block, index) =>
          index > 0 &&
          block.allocationOrder <= manifest.ssccRevokedBlocks[index - 1]!.allocationOrder,
      ) ||
      (manifest.sscc !== null && revokedOrders.has(manifest.sscc.allocationOrder))
    ) {
      context.addIssue({ code: "custom", message: "unsafe SSCC revoked block list" });
    }
  });

export const stationInventoryBundlePageSchema = z.strictObject({
  snapshotId: z.uuid(),
  snapshotRevision: z.literal(1),
  snapshotFixedAt: z.iso.datetime(),
  combinedDigest: digestSchema,
  contentDigest: digestSchema,
  cursor: digestSchema.nullable(),
  items: z
    .array(stationInventoryBundleCodeSchema)
    .max(STATION_INVENTORY_BUNDLE_LIMITS.codePageSize),
  nextCursor: digestSchema.nullable(),
  pageDigest: digestSchema,
});

export type StationInventoryBundleCode = z.infer<typeof stationInventoryBundleCodeSchema>;
export type StationInventoryBundleManifest = z.infer<typeof stationInventoryBundleManifestSchema>;
export type StationInventoryBundlePage = z.infer<typeof stationInventoryBundlePageSchema>;

export function parseStationInventoryBundleManifest(
  value: unknown,
): StationInventoryBundleManifest {
  const parsed = stationInventoryBundleManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid station inventory bundle manifest");
  return parsed.data;
}

export function parseStationInventoryBundlePage(value: unknown): StationInventoryBundlePage {
  const parsed = stationInventoryBundlePageSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid station inventory bundle page");
  return parsed.data;
}

function digestJson(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}

function canonicalContentItem(item: StationInventoryBundleCode) {
  return {
    codeHash: item.codeHash,
    canonicalRaw: item.canonicalRaw,
    gtin14: item.gtin14,
    serial: item.serial,
    sourceStatus: item.sourceStatus,
    sourceState: item.sourceState,
    sourceProductionDate: item.sourceProductionDate,
    parentSscc: item.parentSscc,
    expected: item.expected,
    protected: item.protected,
  };
}

export function inventorySnapshotContentDigest(
  items: readonly StationInventoryBundleCode[],
): string {
  for (let index = 1; index < items.length; index += 1) {
    if (items[index - 1]!.codeHash >= items[index]!.codeHash) {
      throw new Error("Inventory snapshot content requires strict code-hash order");
    }
  }
  return digestJson({ version: 1, items: items.map(canonicalContentItem) });
}

export function inventorySnapshotPageDigest(input: {
  snapshotId: string;
  snapshotFixedAt: string;
  contentDigest: string;
  cursor: string | null;
  items: readonly StationInventoryBundleCode[];
  nextCursor: string | null;
}): string {
  return digestJson({
    version: 1,
    snapshotId: input.snapshotId,
    snapshotFixedAt: input.snapshotFixedAt,
    contentDigest: input.contentDigest,
    cursor: input.cursor,
    items: input.items.map(canonicalContentItem),
    nextCursor: input.nextCursor,
  });
}
