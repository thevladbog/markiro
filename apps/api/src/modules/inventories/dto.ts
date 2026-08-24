import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

export type {
  StationInventoryLabelTemplateDescriptor,
  StationInventoryManifest,
} from "./station-inventory.dto";

export const INVENTORY_MODES = ["check", "repack"] as const;
export type InventoryMode = (typeof INVENTORY_MODES)[number];

export const INVENTORY_LIFECYCLE_STATUSES = [
  "draft",
  "preparing",
  "ready",
  "running",
  "closed",
  "completed",
] as const;
export type InventoryLifecycleStatus = (typeof INVENTORY_LIFECYCLE_STATUSES)[number];

export function inventoryCivilDateSchema(field: "productionDateFrom" | "productionDateTo") {
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

const productionDateFromSchema = inventoryCivilDateSchema("productionDateFrom");
const productionDateToSchema = inventoryCivilDateSchema("productionDateTo");

export const createInventorySchema = z.object({
  productId: z.string().uuid(),
  lineId: z.string().uuid(),
  mode: z.enum(INVENTORY_MODES),
  productionDateFrom: productionDateFromSchema,
  productionDateTo: productionDateToSchema,
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
});
export type CreateInventoryDto = z.infer<typeof createInventorySchema>;

export const updateInventorySchema = z.object({
  productId: z.string().uuid().optional(),
  lineId: z.string().uuid().optional(),
  mode: z.enum(INVENTORY_MODES).optional(),
  productionDateFrom: productionDateFromSchema.optional(),
  productionDateTo: productionDateToSchema.optional(),
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
});
export type UpdateInventoryDto = z.infer<typeof updateInventorySchema>;

export const inventoryImportStatusSchema = z.enum(INVENTORY_CHZ_STATUSES);
export const inventoryIdSchema = z.string().uuid();

export interface InventoryLabelTemplateDto {
  id: string;
  name: string;
}

export interface InventoryDto {
  id: string;
  number: string;
  status: InventoryLifecycleStatus;
  mode: InventoryMode;
  productId: string;
  gtin14: string;
  productName: string;
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
  boxLabelTemplate: InventoryLabelTemplateDto | null;
  activeSnapshotId: string | null;
  resultRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListInventoriesResponseDto {
  items: InventoryDto[];
}

export interface InventoryImportDiagnosticDto {
  code: string;
  rowNumber?: number;
}

export interface InventoryImportDto {
  id: string;
  declaredStatus: InventoryChzStatus;
  parsedStatus: InventoryChzStatus | null;
  result: "succeeded" | "failed";
  rowCount: number;
  errorCount: number;
  duplicateCount: number;
  sha256: string;
  diagnostics: InventoryImportDiagnosticDto[];
}

const selectedInventoryImportsSchema = z
  .strictObject({
    EMITTED: z.string().uuid(),
    INTRODUCED: z.string().uuid(),
    APPLIED: z.string().uuid(),
    RETIRED: z.string().uuid(),
    WRITTEN_OFF: z.string().uuid(),
    DISAGGREGATION: z.string().uuid(),
  })
  .superRefine((imports, context) => {
    const seen = new Map<string, InventoryChzStatus>();
    for (const status of INVENTORY_CHZ_STATUSES) {
      const importId = imports[status];
      const previousStatus = seen.get(importId);
      if (previousStatus !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Import is already selected for ${previousStatus}`,
          path: [status],
        });
      } else {
        seen.set(importId, status);
      }
    }
  });

export const fixInventorySnapshotSchema = z.strictObject({
  imports: selectedInventoryImportsSchema,
});
export type FixInventorySnapshotDto = z.infer<typeof fixInventorySnapshotSchema>;
export type InventorySnapshotInputSelectionDto = FixInventorySnapshotDto["imports"];

export interface InventorySnapshotCountsDto {
  emitted: number;
  introduced: number;
  applied: number;
  retired: number;
  writtenOff: number;
  disaggregation: number;
  protected: number;
  expected: number;
  packages: number;
  loose: number;
}

export interface InventorySnapshotDto {
  id: string;
  inventoryId: string;
  revision: number;
  combinedDigest: string;
  fixedAt: string;
  inputs: InventorySnapshotInputSelectionDto;
  counts: InventorySnapshotCountsDto;
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateSchema = { type: "string", format: "date" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const createInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "lineId", "mode", "productionDateFrom", "productionDateTo"],
  properties: {
    productId: uuidSchema,
    lineId: uuidSchema,
    mode: { type: "string", enum: [...INVENTORY_MODES] },
    productionDateFrom: dateSchema,
    productionDateTo: dateSchema,
    boxLabelTemplateId: { ...uuidSchema, nullable: true },
  },
};

export const updateInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    productId: uuidSchema,
    lineId: uuidSchema,
    mode: { type: "string", enum: [...INVENTORY_MODES] },
    productionDateFrom: dateSchema,
    productionDateTo: dateSchema,
    boxLabelTemplateId: { ...uuidSchema, nullable: true },
  },
};

export const inventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "number",
    "status",
    "mode",
    "productId",
    "gtin14",
    "productName",
    "lineId",
    "lineName",
    "productionDateFrom",
    "productionDateTo",
    "boxLabelTemplateId",
    "boxLabelTemplate",
    "activeSnapshotId",
    "resultRevision",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    number: { type: "string" },
    status: { type: "string", enum: [...INVENTORY_LIFECYCLE_STATUSES] },
    mode: { type: "string", enum: [...INVENTORY_MODES] },
    productId: uuidSchema,
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    productName: { type: "string" },
    lineId: uuidSchema,
    lineName: { type: "string" },
    productionDateFrom: dateSchema,
    productionDateTo: dateSchema,
    boxLabelTemplateId: { ...uuidSchema, nullable: true },
    boxLabelTemplate: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["id", "name"],
      properties: {
        id: uuidSchema,
        name: { type: "string" },
      },
    },
    activeSnapshotId: { ...uuidSchema, nullable: true },
    resultRevision: { type: "integer", minimum: 0 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

export const listInventoriesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: inventoryOpenApiSchema } },
};

export const inventoryImportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "declaredStatus",
    "parsedStatus",
    "result",
    "rowCount",
    "errorCount",
    "duplicateCount",
    "sha256",
    "diagnostics",
  ],
  properties: {
    id: uuidSchema,
    declaredStatus: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] },
    parsedStatus: { type: "string", enum: [...INVENTORY_CHZ_STATUSES], nullable: true },
    result: { type: "string", enum: ["succeeded", "failed"] },
    rowCount: { type: "integer", minimum: 0 },
    errorCount: { type: "integer", minimum: 0 },
    duplicateCount: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
          rowNumber: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

const inventorySnapshotInputProperties = Object.fromEntries(
  INVENTORY_CHZ_STATUSES.map((status) => [status, uuidSchema]),
);

export const fixInventorySnapshotOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["imports"],
  properties: {
    imports: {
      type: "object",
      additionalProperties: false,
      required: [...INVENTORY_CHZ_STATUSES],
      properties: inventorySnapshotInputProperties,
    },
  },
};

const inventorySnapshotCountProperties = {
  emitted: { type: "integer", minimum: 0 },
  introduced: { type: "integer", minimum: 0 },
  applied: { type: "integer", minimum: 0 },
  retired: { type: "integer", minimum: 0 },
  writtenOff: { type: "integer", minimum: 0 },
  disaggregation: { type: "integer", minimum: 0 },
  protected: { type: "integer", minimum: 0 },
  expected: { type: "integer", minimum: 0 },
  packages: { type: "integer", minimum: 0 },
  loose: { type: "integer", minimum: 0 },
} satisfies Record<keyof InventorySnapshotCountsDto, SchemaObject>;

export const inventorySnapshotOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "inventoryId", "revision", "combinedDigest", "fixedAt", "inputs", "counts"],
  properties: {
    id: uuidSchema,
    inventoryId: uuidSchema,
    revision: { type: "integer", minimum: 1 },
    combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    fixedAt: dateTimeSchema,
    inputs: {
      type: "object",
      additionalProperties: false,
      required: [...INVENTORY_CHZ_STATUSES],
      properties: inventorySnapshotInputProperties,
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(inventorySnapshotCountProperties),
      properties: inventorySnapshotCountProperties,
    },
  },
};
