import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type {
  PalletExportFormatDescriptor,
  PalletExportFormatId,
  ShiftExportFormatDescriptor,
  ShiftExportFormatId,
} from "@markiro/domain";

import { apiFetch } from "../../api/client.js";

export type ShiftExportStatus = "queued" | "processing" | "ready" | "failed";

export interface ShiftExportArtifactDto {
  id: string;
  partNumber: number;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
  /** Closed pallets this part covers; 0 outside the pallet formats. */
  palletCount: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

/**
 * Mirrors `apps/api/src/modules/shift-exports/dto.ts`'s `ShiftExportDto`. One
 * row type serves both scopes: a shift export has `shiftId` and no
 * `palletId`; a per-pallet export (warehouse pallets, plan 1) the reverse.
 */
export interface ShiftExportDto {
  id: string;
  /** Null exactly when this is a per-pallet export; `palletId` is then set. */
  shiftId: string | null;
  palletId: string | null;
  formatId: ShiftExportFormatId | PalletExportFormatId;
  formatVersion: number;
  maxLines: number | null;
  status: ShiftExportStatus;
  errorCode: string | null;
  productNameSnapshot: string | null;
  shiftDateSnapshot: string | null;
  totalCodeCount: number | null;
  totalBoxCount: number | null;
  /** Null until ready; 0 outside the pallet formats. */
  totalPalletCount: number | null;
  createdByUserId: string;
  createdByName: string | null;
  sourceSnapshotStartedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  createdAt: string;
  stale: boolean;
  artifacts: ShiftExportArtifactDto[];
}

export interface CreateShiftExportInput {
  formatId: ShiftExportFormatId;
  formatVersion: number;
  maxLines: number | null;
  idempotencyKey: string;
}

/** A pallet export has no `maxLines`: one `pack_content`, never split into parts. */
export interface CreatePalletExportInput {
  formatId: PalletExportFormatId;
  formatVersion: number;
  idempotencyKey: string;
}

export interface ShiftExportDownloadDto {
  url: string;
  filename: string;
  expiresInSeconds: 300;
}

export const SHIFT_EXPORT_FORMATS_QUERY_KEY = ["shift-export-formats"] as const;
export const PALLET_EXPORT_FORMATS_QUERY_KEY = ["pallet-export-formats"] as const;

export const shiftExportsQueryKey = (shiftId: string) => ["shift-exports", shiftId] as const;
export const palletExportsQueryKey = (palletId: string) => ["pallet-exports", palletId] as const;

function fetchShiftExportFormats(): Promise<ShiftExportFormatDescriptor[]> {
  return apiFetch<ShiftExportFormatDescriptor[]>("/shift-exports/formats");
}

function fetchPalletExportFormats(): Promise<PalletExportFormatDescriptor[]> {
  return apiFetch<PalletExportFormatDescriptor[]>("/pallet-exports/formats");
}

function fetchShiftExports(shiftId: string): Promise<ShiftExportDto[]> {
  return apiFetch<ShiftExportDto[]>(`/shifts/${shiftId}/exports`);
}

function fetchPalletExports(palletId: string): Promise<ShiftExportDto[]> {
  return apiFetch<ShiftExportDto[]>(`/pallets/${palletId}/exports`);
}

function postShiftExport(shiftId: string, input: CreateShiftExportInput): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/shifts/${shiftId}/exports`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function postPalletExport(
  palletId: string,
  input: CreatePalletExportInput,
): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/pallets/${palletId}/exports`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function postRetryShiftExport(exportId: string): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/shift-exports/${exportId}/retry`, { method: "POST" });
}

export function downloadShiftExportArtifact(
  exportId: string,
  artifactId: string,
): Promise<ShiftExportDownloadDto> {
  return apiFetch<ShiftExportDownloadDto>(
    `/shift-exports/${exportId}/artifacts/${artifactId}/download`,
  );
}

/** Poll every 2 s while any row is still being produced. */
function exportsRefetchInterval(items: ShiftExportDto[] | undefined): number | false {
  return items?.some((item) => item.status === "queued" || item.status === "processing")
    ? 2_000
    : false;
}

export function useShiftExportFormats(): UseQueryResult<ShiftExportFormatDescriptor[]> {
  return useQuery({
    queryKey: SHIFT_EXPORT_FORMATS_QUERY_KEY,
    queryFn: fetchShiftExportFormats,
  });
}

export function usePalletExportFormats(): UseQueryResult<PalletExportFormatDescriptor[]> {
  return useQuery({
    queryKey: PALLET_EXPORT_FORMATS_QUERY_KEY,
    queryFn: fetchPalletExportFormats,
  });
}

export function useShiftExports(
  shiftId: string,
  enabled: boolean,
): UseQueryResult<ShiftExportDto[]> {
  return useQuery({
    queryKey: shiftExportsQueryKey(shiftId),
    queryFn: () => fetchShiftExports(shiftId),
    enabled,
    refetchInterval: (query) => exportsRefetchInterval(query.state.data),
  });
}

export function usePalletExports(
  palletId: string,
  enabled: boolean,
): UseQueryResult<ShiftExportDto[]> {
  return useQuery({
    queryKey: palletExportsQueryKey(palletId),
    queryFn: () => fetchPalletExports(palletId),
    enabled,
    refetchInterval: (query) => exportsRefetchInterval(query.state.data),
  });
}

export function useCreateShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { shiftId: string; input: CreateShiftExportInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ shiftId, input }) => postShiftExport(shiftId, input),
    onSuccess: (_data, { shiftId }) => {
      void queryClient.invalidateQueries({ queryKey: shiftExportsQueryKey(shiftId) });
    },
  });
}

export function useCreatePalletExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { palletId: string; input: CreatePalletExportInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ palletId, input }) => postPalletExport(palletId, input),
    onSuccess: (_data, { palletId }) => {
      void queryClient.invalidateQueries({ queryKey: palletExportsQueryKey(palletId) });
    },
  });
}

/**
 * Retry is one endpoint for both scopes; the row's own `shiftId`/`palletId`
 * says which history list to refresh afterwards.
 */
export function useRetryShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { exportId: string; shiftId: string | null; palletId: string | null }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ exportId }) => postRetryShiftExport(exportId),
    onSuccess: (_data, { shiftId, palletId }) => {
      if (shiftId) {
        void queryClient.invalidateQueries({ queryKey: shiftExportsQueryKey(shiftId) });
      }
      if (palletId) {
        void queryClient.invalidateQueries({ queryKey: palletExportsQueryKey(palletId) });
      }
    },
  });
}
