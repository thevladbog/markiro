import { z } from "zod";
import {
  catalogCapabilitiesSchema,
  chzLinkDetailSchema,
  chzSummarySchema,
  chzLinkChangeSchema,
  type ImportItem,
  importSessionSchema,
  importItemsQuerySchema,
  importItemsResponseSchema,
  importStartSchema,
  importSelectionSchema,
  importPrepareSchema,
  importPrepareResponseSchema,
  importApplySchema,
  importResultSchema,
  importApplyRetrySchema,
  importPhotoSchema,
  type ImportStart,
  type ImportSelection,
  type ImportPrepare,
  type ImportApply,
  type ImportItemsQuery,
} from "@markiro/platform-contracts";
import { apiFetch, API_BASE } from "../../../api/client.js";
const root = "/national-catalog/import-sessions";
const sessionPath = (id: string) => `${root}/${z.uuid().parse(id)}`;
async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
  return schema.parse(await apiFetch<unknown>(path, signal ? { signal } : {}));
}
async function write<T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  signal?: AbortSignal,
  method = "POST",
) {
  return schema.parse(
    await apiFetch<unknown>(path, {
      method,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  );
}
export const getCapabilities = (signal?: AbortSignal) =>
  read("/national-catalog/capabilities", catalogCapabilitiesSchema, signal);
export const startImport = (body: ImportStart, signal?: AbortSignal) =>
  write(root, importSessionSchema, importStartSchema.parse(body), signal);
export const getImportSession = (id: string, signal?: AbortSignal) =>
  read(sessionPath(id), importSessionSchema, signal);
export function getImportItems(id: string, query: ImportItemsQuery, signal?: AbortSignal) {
  const q = importItemsQuerySchema.parse(query);
  const params = new URLSearchParams({
    search: q.search,
    includeArchived: String(q.includeArchived),
    limit: String(q.limit),
  });
  if (q.cursor) params.set("cursor", q.cursor);
  q.statuses.forEach((status) => params.append("statuses", status));
  return read(`${sessionPath(id)}/items?${params}`, importItemsResponseSchema, signal);
}
export const saveImportSelection = (id: string, body: ImportSelection, signal?: AbortSignal) =>
  write(
    `${sessionPath(id)}/selection`,
    importSessionSchema,
    importSelectionSchema.parse(body),
    signal,
    "PUT",
  );
export const prepareImport = (id: string, body: ImportPrepare, signal?: AbortSignal) =>
  write(
    `${sessionPath(id)}/previews`,
    importPrepareResponseSchema,
    importPrepareSchema.parse(body),
    signal,
  );
export const getPreparation = (id: string, preparationId: string, signal?: AbortSignal) =>
  read(
    `${sessionPath(id)}/preparations/${z.uuid().parse(preparationId)}`,
    importPrepareResponseSchema,
    signal,
  );
export const applyImport = (id: string, body: ImportApply, signal?: AbortSignal) =>
  write(`${sessionPath(id)}/applies`, importResultSchema, importApplySchema.parse(body), signal);
export const getImportResult = (id: string, operationId: string, signal?: AbortSignal) =>
  read(`${sessionPath(id)}/applies/${z.uuid().parse(operationId)}`, importResultSchema, signal);
export const retryImport = (
  id: string,
  operationId: string,
  previewIds: string[],
  signal?: AbortSignal,
) =>
  write(
    `${sessionPath(id)}/applies/${z.uuid().parse(operationId)}/retries`,
    importResultSchema,
    importApplyRetrySchema.parse({ previewIds }),
    signal,
  );
export const retrySession = (id: string, signal?: AbortSignal) =>
  write(`${sessionPath(id)}/retries`, importSessionSchema, {}, signal);
export const retryPreparation = (id: string, preparationId: string, signal?: AbortSignal) =>
  write(
    `${sessionPath(id)}/preparations/${z.uuid().parse(preparationId)}/retries`,
    importPrepareResponseSchema,
    {},
    signal,
  );
export const preparePhoto = (
  id: string,
  previewId: string,
  candidateId: string,
  signal?: AbortSignal,
) =>
  write(
    `${sessionPath(id)}/previews/${z.uuid().parse(previewId)}/images/${z.uuid().parse(candidateId)}`,
    importPhotoSchema,
    {},
    signal,
  );
// Never use a provider-controlled previewPath as an image URL.
export const photoUrl = (id: string, candidateId: string) =>
  `${API_BASE}${sessionPath(id)}/images/${z.uuid().parse(candidateId)}`;
export const cancelImport = (id: string, signal?: AbortSignal) =>
  write(`${sessionPath(id)}/cancel`, importSessionSchema, {}, signal);

export const getChzLink = (productId: string, signal?: AbortSignal) =>
  read(`/products/${z.uuid().parse(productId)}/national-catalog/link`, chzLinkDetailSchema, signal);
export const refreshChzLink = (productId: string, signal?: AbortSignal) =>
  write(
    `/products/${z.uuid().parse(productId)}/national-catalog/link/refresh`,
    chzSummarySchema,
    {},
    signal,
  );
export const removeChzLink = (productId: string, expectedRevision: number, signal?: AbortSignal) =>
  write(
    `/products/${z.uuid().parse(productId)}/national-catalog/link`,
    chzSummarySchema,
    chzLinkChangeSchema.parse({ action: "remove", expectedRevision }),
    signal,
    "DELETE",
  );

/** Exhaust only the fresh session's saved feed; never select from a partial traversal. */
export async function getExactCardItems(id: string, signal?: AbortSignal) {
  const items: ImportItem[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const data = await getImportItems(
      id,
      { cursor, search: "", statuses: [], includeArchived: true, limit: 100 },
      signal,
    );
    items.push(...data.items);
    if (data.nextCursor === null) return items;
    if (seen.has(data.nextCursor)) throw new Error("incomplete_feed");
    seen.add(data.nextCursor);
    cursor = data.nextCursor;
  }
  throw new Error("incomplete_feed");
}
