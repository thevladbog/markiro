import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type { ShiftExportFormatDescriptor, ShiftExportFormatId } from "@markiro/domain";

import { apiFetch } from "../../api/client.js";

export type ShiftExportStatus = "queued" | "processing" | "ready" | "failed";

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
  status: ShiftExportStatus;
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

export interface CreateShiftExportInput {
  formatId: ShiftExportFormatId;
  formatVersion: number;
  maxLines: number | null;
  idempotencyKey: string;
}

export interface ShiftExportDownloadDto {
  url: string;
  filename: string;
  expiresInSeconds: 300;
}

export const SHIFT_EXPORT_FORMATS_QUERY_KEY = ["shift-export-formats"] as const;

export const shiftExportsQueryKey = (shiftId: string) => ["shift-exports", shiftId] as const;

function fetchShiftExportFormats(): Promise<ShiftExportFormatDescriptor[]> {
  return apiFetch<ShiftExportFormatDescriptor[]>("/shift-exports/formats");
}

function fetchShiftExports(shiftId: string): Promise<ShiftExportDto[]> {
  return apiFetch<ShiftExportDto[]>(`/shifts/${shiftId}/exports`);
}

function postShiftExport(shiftId: string, input: CreateShiftExportInput): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/shifts/${shiftId}/exports`, {
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

export function useShiftExportFormats(): UseQueryResult<ShiftExportFormatDescriptor[]> {
  return useQuery({
    queryKey: SHIFT_EXPORT_FORMATS_QUERY_KEY,
    queryFn: fetchShiftExportFormats,
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
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "queued" || item.status === "processing")
        ? 2_000
        : false,
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

export function useRetryShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { shiftId: string; exportId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ exportId }) => postRetryShiftExport(exportId),
    onSuccess: (_data, { shiftId }) => {
      void queryClient.invalidateQueries({ queryKey: shiftExportsQueryKey(shiftId) });
    },
  });
}
