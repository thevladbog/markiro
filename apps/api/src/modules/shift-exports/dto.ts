import { z } from "zod";
import type { ShiftExportFormatDescriptor, ShiftExportFormatId } from "@markiro/domain";

export const createShiftExportSchema = z.strictObject({
  formatId: z.enum(["shift_txt_flat", "shift_txt_boxes", "shift_csv_flat", "shift_csv_boxes"]),
  formatVersion: z.number().int().min(1),
  maxLines: z.number().int().min(2).max(1_000_000).nullable(),
  idempotencyKey: z.uuid(),
});

export type CreateShiftExportDto = z.infer<typeof createShiftExportSchema>;
export type ShiftExportFormatsDto = readonly ShiftExportFormatDescriptor[];

export interface ShiftExportArtifactDto {
  id: string;
  partNumber: number;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export interface ShiftExportDto {
  id: string;
  shiftId: string;
  formatId: ShiftExportFormatId;
  formatVersion: number;
  maxLines: number | null;
  status: "queued" | "processing" | "ready" | "failed";
  errorCode: string | null;
  productNameSnapshot: string | null;
  shiftDateSnapshot: string | null;
  totalCodeCount: number | null;
  totalBoxCount: number | null;
  createdByUserId: string;
  createdByName: string | null;
  sourceSnapshotStartedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  createdAt: string;
  stale: boolean;
  artifacts: ShiftExportArtifactDto[];
}

export interface ShiftExportDownloadDto {
  url: string;
  filename: string;
  expiresInSeconds: 300;
}

export const shiftExportFormatOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "label", "extension", "mimeType", "boxMode"],
  properties: {
    id: {
      type: "string",
      enum: ["shift_txt_flat", "shift_txt_boxes", "shift_csv_flat", "shift_csv_boxes"],
    },
    version: { type: "integer", enum: [1, 2] },
    label: { type: "string" },
    extension: { type: "string", enum: ["txt", "csv"] },
    mimeType: { type: "string" },
    boxMode: { type: "string", enum: ["flat", "boxes"] },
  },
};

export const createShiftExportOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["formatId", "formatVersion", "maxLines", "idempotencyKey"],
  properties: {
    formatId: shiftExportFormatOpenApiSchema.properties.id,
    formatVersion: { type: "integer", minimum: 1 },
    maxLines: { type: "integer", nullable: true, minimum: 2, maximum: 1_000_000 },
    idempotencyKey: { type: "string", format: "uuid" },
  },
};

export const shiftExportArtifactOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "partNumber",
    "physicalLineCount",
    "codeCount",
    "boxCount",
    "filename",
    "mimeType",
    "byteSize",
    "sha256",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    partNumber: { type: "integer", minimum: 1 },
    physicalLineCount: { type: "integer", minimum: 1 },
    codeCount: { type: "integer", minimum: 1 },
    boxCount: { type: "integer", minimum: 0 },
    filename: { type: "string" },
    mimeType: { type: "string" },
    byteSize: { type: "integer", minimum: 1 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
};

export const shiftExportOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "shiftId",
    "formatId",
    "formatVersion",
    "maxLines",
    "status",
    "errorCode",
    "productNameSnapshot",
    "shiftDateSnapshot",
    "totalCodeCount",
    "totalBoxCount",
    "createdByUserId",
    "createdByName",
    "sourceSnapshotStartedAt",
    "completedAt",
    "attemptCount",
    "createdAt",
    "stale",
    "artifacts",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    shiftId: { type: "string", format: "uuid" },
    formatId: shiftExportFormatOpenApiSchema.properties.id,
    formatVersion: { type: "integer", minimum: 1 },
    maxLines: { type: "integer", nullable: true, minimum: 2, maximum: 1_000_000 },
    status: { type: "string", enum: ["queued", "processing", "ready", "failed"] },
    errorCode: { type: "string", nullable: true },
    productNameSnapshot: { type: "string", nullable: true },
    shiftDateSnapshot: { type: "string", format: "date", nullable: true },
    totalCodeCount: { type: "integer", nullable: true, minimum: 1 },
    totalBoxCount: { type: "integer", nullable: true, minimum: 0 },
    createdByUserId: { type: "string" },
    createdByName: { type: "string", nullable: true },
    sourceSnapshotStartedAt: { type: "string", format: "date-time", nullable: true },
    completedAt: { type: "string", format: "date-time", nullable: true },
    attemptCount: { type: "integer", minimum: 0 },
    createdAt: { type: "string", format: "date-time" },
    stale: { type: "boolean" },
    artifacts: { type: "array", items: shiftExportArtifactOpenApiSchema },
  },
};

export const shiftExportDownloadOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "filename", "expiresInSeconds"],
  properties: {
    url: { type: "string", format: "uri" },
    filename: { type: "string" },
    expiresInSeconds: { type: "integer", enum: [300] },
  },
};
