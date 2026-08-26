import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";
import {
  createInventoryInputSchema,
  createInventoryCorrectionInputSchema,
  inventoryCorrectionSchema,
  inventoryCloseResponseSchema,
  inventoryCompleteResponseSchema,
  inventoryDetailSchema,
  inventoryEvidenceResponseSchema,
  inventoryImportSchema,
  inventorySchema,
  inventoryProgressSchema,
  inventoryLateEventsDiscardResponseSchema,
  inventoryLateEventsResponseSchema,
  inventoryReopenResponseSchema,
  inventorySnapshotInputsSchema,
  inventorySnapshotSchema,
  listInventoriesSchema,
  stationInventoryManifestSchema,
  type CreateInventoryInput,
  type CreateInventoryCorrectionInput,
  type Inventory,
  type InventoryCorrection,
  type InventoryCloseResponse,
  type InventoryCompleteResponse,
  type InventoryChzStatus,
  type InventoryDetail,
  type InventoryEvidenceResponse,
  type InventoryImport,
  type InventoryProgress,
  type InventoryLateEventsResponse,
  type InventoryReopenResponse,
  type InventorySnapshot,
  type InventorySnapshotInputs,
} from "./schemas.js";

export const INVENTORIES_QUERY_KEY = ["inventories"] as const;

export function inventoryProgressQueryKey(id: string) {
  return [...INVENTORIES_QUERY_KEY, id, "progress"] as const;
}

export function inventoryLateEventsQueryKey(id: string, page?: number) {
  return [
    ...INVENTORIES_QUERY_KEY,
    id,
    "late-events",
    ...(page === undefined ? [] : [page]),
  ] as const;
}

export interface InventoryEvidenceQuery {
  search?: string;
  kind?: "item" | "known_box" | "old_box";
  classification?: "expected" | "protected" | "ineligible" | "unknown" | "voided";
  page: number;
  pageSize: number;
}

function inventoryEvidenceQueryKey(id: string, query: InventoryEvidenceQuery) {
  return [...INVENTORIES_QUERY_KEY, id, "evidence", query] as const;
}

async function listInventories(): Promise<Inventory[]> {
  const value = await apiFetch<unknown>("/inventories");
  return listInventoriesSchema.parse(value).items;
}

async function getInventory(id: string): Promise<InventoryDetail> {
  const value = await apiFetch<unknown>(`/inventories/${id}`);
  return inventoryDetailSchema.parse(value);
}

async function getInventoryProgress(id: string): Promise<InventoryProgress> {
  const value = await apiFetch<unknown>(`/inventories/${id}/progress`);
  return inventoryProgressSchema.parse(value);
}

async function getInventoryEvidence(
  id: string,
  query: InventoryEvidenceQuery,
): Promise<InventoryEvidenceResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.search) params.set("search", query.search);
  if (query.kind) params.set("kind", query.kind);
  if (query.classification) params.set("classification", query.classification);
  const value = await apiFetch<unknown>(`/inventories/${id}/evidence?${params.toString()}`);
  return inventoryEvidenceResponseSchema.parse(value);
}

async function createInventoryCorrection(input: {
  inventoryId: string;
  correction: CreateInventoryCorrectionInput;
}): Promise<InventoryCorrection> {
  const correction = createInventoryCorrectionInputSchema.parse(input.correction);
  const value = await apiFetch<unknown>(`/inventories/${input.inventoryId}/corrections`, {
    method: "POST",
    body: JSON.stringify(correction),
  });
  return inventoryCorrectionSchema.parse(value);
}

async function createInventory(input: CreateInventoryInput): Promise<Inventory> {
  const value = await apiFetch<unknown>("/inventories", {
    method: "POST",
    body: JSON.stringify(createInventoryInputSchema.parse(input)),
  });
  return inventorySchema.parse(value);
}

async function updateInventory(input: {
  inventoryId: string;
  parameters: CreateInventoryInput;
}): Promise<Inventory> {
  const value = await apiFetch<unknown>(`/inventories/${input.inventoryId}`, {
    method: "PATCH",
    body: JSON.stringify(createInventoryInputSchema.parse(input.parameters)),
  });
  return inventorySchema.parse(value);
}

async function uploadInventoryImport(input: {
  inventoryId: string;
  status: InventoryChzStatus;
  file: File;
}): Promise<InventoryImport> {
  const body = new FormData();
  body.append("file", input.file, input.file.name || "inventory-upload");
  const value = await apiFetch<unknown>(
    `/inventories/${input.inventoryId}/imports/${input.status}`,
    { method: "POST", body },
  );
  return inventoryImportSchema.parse(value);
}

async function fixInventorySnapshot(input: {
  inventoryId: string;
  imports: InventorySnapshotInputs;
}): Promise<InventorySnapshot> {
  const imports = inventorySnapshotInputsSchema.parse(input.imports);
  const value = await apiFetch<unknown>(`/inventories/${input.inventoryId}/snapshots`, {
    method: "POST",
    body: JSON.stringify({ imports }),
  });
  return inventorySnapshotSchema.parse(value);
}

async function startInventory(inventoryId: string): Promise<void> {
  const value = await apiFetch<unknown>(`/inventories/${inventoryId}/start`, { method: "POST" });
  stationInventoryManifestSchema.parse(value);
}

async function closeInventory(input: {
  inventoryId: string;
  emergencyReason?: string;
}): Promise<InventoryCloseResponse> {
  const emergency = input.emergencyReason !== undefined;
  const value = await apiFetch<unknown>(
    `/inventories/${input.inventoryId}/${emergency ? "emergency-close" : "close"}`,
    {
      method: "POST",
      body: JSON.stringify(
        emergency ? { reason: input.emergencyReason, acknowledgeBlockers: true } : {},
      ),
    },
  );
  return inventoryCloseResponseSchema.parse(value);
}

async function reopenInventory(inventoryId: string): Promise<InventoryReopenResponse> {
  const value = await apiFetch<unknown>(`/inventories/${inventoryId}/reopen`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return inventoryReopenResponseSchema.parse(value);
}

async function completeInventory(inventoryId: string): Promise<InventoryCompleteResponse> {
  const value = await apiFetch<unknown>(`/inventories/${inventoryId}/complete`, {
    method: "POST",
    body: JSON.stringify({ documentsDownloadedAndChecked: true }),
  });
  return inventoryCompleteResponseSchema.parse(value);
}

async function getInventoryLateEvents(
  inventoryId: string,
  page: number,
): Promise<InventoryLateEventsResponse> {
  const value = await apiFetch<unknown>(
    `/inventories/${inventoryId}/late-events?page=${page}&pageSize=50`,
  );
  return inventoryLateEventsResponseSchema.parse(value);
}

async function discardInventoryLateEvents(input: {
  inventoryId: string;
  lateEventIds: string[];
  reason: string;
}): Promise<number> {
  const value = await apiFetch<unknown>(`/inventories/${input.inventoryId}/late-events/discard`, {
    method: "POST",
    body: JSON.stringify({ lateEventIds: input.lateEventIds, reason: input.reason }),
  });
  return inventoryLateEventsDiscardResponseSchema.parse(value).discardedCount;
}

function invalidateInventory(queryClient: ReturnType<typeof useQueryClient>, inventoryId: string) {
  void queryClient.invalidateQueries({ queryKey: INVENTORIES_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: [...INVENTORIES_QUERY_KEY, inventoryId] });
}

export function useInventories(): UseQueryResult<Inventory[]> {
  return useQuery({ queryKey: INVENTORIES_QUERY_KEY, queryFn: listInventories });
}

export function useInventory(id: string): UseQueryResult<InventoryDetail> {
  return useQuery({ queryKey: [...INVENTORIES_QUERY_KEY, id], queryFn: () => getInventory(id) });
}

export function useInventoryProgress(
  id: string,
  enabled = true,
): UseQueryResult<InventoryProgress> {
  return useQuery({
    queryKey: inventoryProgressQueryKey(id),
    queryFn: () => getInventoryProgress(id),
    enabled: enabled && id.length > 0,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5_000 : false),
  });
}

export function useInventoryEvidence(
  id: string,
  query: InventoryEvidenceQuery,
  enabled = true,
): UseQueryResult<InventoryEvidenceResponse> {
  return useQuery({
    queryKey: inventoryEvidenceQueryKey(id, query),
    queryFn: () => getInventoryEvidence(id, query),
    enabled: enabled && id.length > 0,
  });
}

export function useCreateInventoryCorrection(): UseMutationResult<
  InventoryCorrection,
  Error,
  { inventoryId: string; correction: CreateInventoryCorrectionInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createInventoryCorrection,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: [...INVENTORIES_QUERY_KEY, input.inventoryId],
      });
      void queryClient.invalidateQueries({
        queryKey: inventoryProgressQueryKey(input.inventoryId),
      });
    },
  });
}

export function useCreateInventory(): UseMutationResult<Inventory, Error, CreateInventoryInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createInventory,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVENTORIES_QUERY_KEY }),
  });
}

export function useUpdateInventory(): UseMutationResult<
  Inventory,
  Error,
  { inventoryId: string; parameters: CreateInventoryInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateInventory,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: INVENTORIES_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: [...INVENTORIES_QUERY_KEY, input.inventoryId],
      });
    },
  });
}

export function useUploadInventoryImport(): UseMutationResult<
  InventoryImport,
  Error,
  { inventoryId: string; status: InventoryChzStatus; file: File }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadInventoryImport,
    onSettled: (_result, _error, input) =>
      queryClient.invalidateQueries({ queryKey: [...INVENTORIES_QUERY_KEY, input.inventoryId] }),
  });
}

export function useFixInventorySnapshot(): UseMutationResult<
  InventorySnapshot,
  Error,
  { inventoryId: string; imports: InventorySnapshotInputs }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fixInventorySnapshot,
    onSuccess: (_result, input) =>
      queryClient.invalidateQueries({ queryKey: [...INVENTORIES_QUERY_KEY, input.inventoryId] }),
  });
}

export function useStartInventory(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startInventory,
    onSuccess: (_result, inventoryId) => {
      void queryClient.invalidateQueries({ queryKey: INVENTORIES_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: [...INVENTORIES_QUERY_KEY, inventoryId],
      });
    },
  });
}

export function useCloseInventory(): UseMutationResult<
  InventoryCloseResponse,
  Error,
  { inventoryId: string; emergencyReason?: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: closeInventory,
    onSuccess: (_result, input) => invalidateInventory(queryClient, input.inventoryId),
  });
}

export function useReopenInventory(): UseMutationResult<InventoryReopenResponse, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reopenInventory,
    onSuccess: (_result, inventoryId) => invalidateInventory(queryClient, inventoryId),
  });
}

export function useCompleteInventory(): UseMutationResult<
  InventoryCompleteResponse,
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: completeInventory,
    onSuccess: (_result, inventoryId) => invalidateInventory(queryClient, inventoryId),
  });
}

export function useInventoryLateEvents(
  inventoryId: string,
  enabled: boolean,
  page = 1,
): UseQueryResult<InventoryLateEventsResponse> {
  return useQuery({
    queryKey: inventoryLateEventsQueryKey(inventoryId, page),
    queryFn: () => getInventoryLateEvents(inventoryId, page),
    enabled: enabled && inventoryId.length > 0,
  });
}

export function useDiscardInventoryLateEvents(): UseMutationResult<
  number,
  Error,
  { inventoryId: string; lateEventIds: string[]; reason: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: discardInventoryLateEvents,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: inventoryLateEventsQueryKey(input.inventoryId),
      });
    },
  });
}
