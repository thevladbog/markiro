import { z } from "zod";

// The files the office generates, kept on the host (host migration `0029`):
// mirrors `markiro_proto::export_files`. Answers are lenient (`z.object`),
// bodies strict (`.strict()`), as the Rust types;
// `proto/fixtures/export-file*.json` and `export-settings*.json` hold the
// shapes both sides read.

/** A chunk of a file, in bytes of the file (`EXPORT_FILE_CHUNK_BYTES`). */
export const EXPORT_FILE_CHUNK_BYTES = 1_048_576;
/** The largest file the host stores (`EXPORT_FILE_MAX_BYTES`). */
export const EXPORT_FILE_MAX_BYTES = 256 * 1_048_576;
/** The most parts one export stores (`EXPORT_FILE_MAX_PARTS`). */
export const EXPORT_FILE_MAX_PARTS = 1_000;
/** The retention the administrator may choose, in days (`EXPORT_RETENTION_*_DAYS`). */
export const EXPORT_RETENTION_MIN_DAYS = 30;
export const EXPORT_RETENTION_MAX_DAYS = 3650;
/** The printed forms' format ids (`FORM_FORMATS`), all at version 1. */
export const FORM_FORMATS = [
  "form_box",
  "form_pallet",
  "form_placard",
  "form_placards",
  "form_task",
  "form_act",
] as const;
export type FormFormat = (typeof FORM_FORMATS)[number];

export const exportFileKindSchema = z.enum([
  "shift_export",
  "pallet_export",
  "disaggregation_xml",
  "form",
]);
export type ExportFileKind = z.infer<typeof exportFileKindSchema>;

export const exportTargetTypeSchema = z.enum([
  "shift",
  "pallet",
  "warehouse_pallet",
  "box",
  "disaggregation_document",
]);
export type ExportTargetType = z.infer<typeof exportTargetTypeSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/** A stored file's record (the bytes are served by chunks). */
export const exportFileSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid(),
  partNo: z.number().int().positive(),
  kind: exportFileKindSchema,
  targetType: exportTargetTypeSchema,
  targetId: z.string(),
  shiftId: z.string().nullable(),
  formatId: z.string(),
  formatVersion: z.number().int().positive(),
  fileName: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: sha256Schema,
  generator: z.string(),
  createdAt: z.string(),
  userName: z.string().nullable(),
});
export type ExportFile = z.infer<typeof exportFileSchema>;

export const exportFileListSchema = z.object({ items: z.array(exportFileSchema) });
export type ExportFileList = z.infer<typeof exportFileListSchema>;

/** `POST /v1/office/export-files`: a file of one chunk may carry its bytes whole. */
export const exportFileBeginSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    partNo: z.number().int().positive(),
    kind: exportFileKindSchema,
    targetType: exportTargetTypeSchema,
    targetId: z.string(),
    formatId: z.string(),
    formatVersion: z.number().int().positive(),
    fileName: z.string(),
    sizeBytes: z.number().int().positive(),
    sha256: sha256Schema,
    generator: z.string(),
    contentBase64: z.string().optional(),
  })
  .strict();
export type ExportFileBegin = z.infer<typeof exportFileBeginSchema>;

export const exportFileChunkPutSchema = z.object({ contentBase64: z.string() }).strict();
export type ExportFileChunkPut = z.infer<typeof exportFileChunkPutSchema>;

export const exportFileProgressSchema = z.object({
  id: z.uuid(),
  chunkCount: z.number().int().positive(),
  receivedChunks: z.number().int().nonnegative(),
  ready: z.boolean(),
});
export type ExportFileProgress = z.infer<typeof exportFileProgressSchema>;

/** `POST …/{id}/download`: the host checked the stored bytes; the chunks follow. */
export const exportFileOpenedSchema = z.object({
  file: exportFileSchema,
  chunkCount: z.number().int().positive(),
});
export type ExportFileOpened = z.infer<typeof exportFileOpenedSchema>;

export const exportFileChunkSchema = z.object({ contentBase64: z.string() });
export type ExportFileChunk = z.infer<typeof exportFileChunkSchema>;

export const exportSettingsSchema = z.object({
  retentionDays: z.number().int().nullable(),
  fileCount: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  originalBytes: z.number().int().nonnegative(),
  maxStoredBytes: z.number().int().positive(),
});
export type ExportSettings = z.infer<typeof exportSettingsSchema>;

export const exportSettingsUpdateSchema = z
  .object({ retentionDays: z.number().int().nullable() })
  .strict();
export type ExportSettingsUpdate = z.infer<typeof exportSettingsUpdateSchema>;

/** What a list of stored files is narrowed to: a shift's, or a card's. */
export type ExportFileQuery =
  | { shiftId: string; kind?: ExportFileKind }
  | { targetType: ExportTargetType; targetId: string; kind?: ExportFileKind };

/** The path of `GET /v1/office/export-files` for `query`. */
export function exportFilesPath(query: ExportFileQuery): string {
  const params = new URLSearchParams();
  if ("shiftId" in query) params.set("shiftId", query.shiftId);
  else {
    params.set("targetType", query.targetType);
    params.set("targetId", query.targetId);
  }
  if (query.kind !== undefined) params.set("kind", query.kind);
  return `/v1/office/export-files?${params.toString()}`;
}
