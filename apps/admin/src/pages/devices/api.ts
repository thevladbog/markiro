import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "../../api/client.js";

export type DeviceType = "station" | "kiosk";
export type DeviceStatus = "awaiting_pairing" | "online" | "offline" | "revoked";
export interface DeviceDto {
  id: string;
  type: DeviceType;
  name: string;
  place: { id: string | null; name: string | null };
  status: DeviceStatus;
  lastSeenAt: string | null;
  paired: boolean;
}
export interface DevicesParams {
  type?: DeviceType;
  status?: DeviceStatus;
  page: number;
  pageSize: number;
}
export interface DevicesResponse {
  items: DeviceDto[];
  page: number;
  pageSize: number;
  total: number;
}
export interface CreateStationInput {
  name: string;
  lineId: string | null;
}
export interface CreateKioskInput {
  name: string;
  location?: string | null;
  dayLimitPerEmployee?: number;
  showPrices?: boolean;
}
export interface UpdateStationInput {
  name?: string;
  lineId?: string | null;
}
export interface UpdateKioskInput {
  name?: string;
  location?: string | null;
  dayLimitPerEmployee?: number;
  showPrices?: boolean;
  status?: "active" | "archived";
}
export interface PairingCode {
  code: string;
  expiresAt: string;
}
export interface CreatedDevice {
  id: string;
  name: string;
}
export const DEVICES_QUERY_KEY = ["devices"] as const;
export const KIOSKS_QUERY_KEY = ["kiosks"] as const;
function key(params: DevicesParams) {
  return [...DEVICES_QUERY_KEY, params] as const;
}
function listPath(params: DevicesParams) {
  const q = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
  if (params.type) q.set("type", params.type);
  if (params.status) q.set("status", params.status);
  return `/devices?${q}`;
}
export function useDevices(params: DevicesParams): UseQueryResult<DevicesResponse> {
  return useQuery({
    queryKey: key(params),
    queryFn: () => apiFetch<DevicesResponse>(listPath(params)),
  });
}
function useDeviceMutation<T, V>(
  fn: (value: V) => Promise<T>,
  kiosk = false,
): UseMutationResult<T, Error, V> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
      if (kiosk) void qc.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}
export function useCreateStation() {
  return useDeviceMutation((input: CreateStationInput) =>
    apiFetch<CreatedDevice>("/station-devices", { method: "POST", body: JSON.stringify(input) }),
  );
}
export function useUpdateStation() {
  return useDeviceMutation(({ id, input }: { id: string; input: UpdateStationInput }) =>
    apiFetch(`/station-devices/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  );
}
export function useRevokeStation() {
  return useDeviceMutation((id: string) =>
    apiFetch<void>(`/station-devices/${id}`, { method: "DELETE" }),
  );
}
export function useIssueStationCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PairingCode>(`/station-devices/${id}/pairing-code`, { method: "POST" }),
    gcTime: 0,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    },
  });
}
export function useCreateKiosk() {
  return useDeviceMutation(
    (input: CreateKioskInput) =>
      apiFetch<CreatedDevice>("/kiosks", { method: "POST", body: JSON.stringify(input) }),
    true,
  );
}
export function useUpdateKiosk() {
  return useDeviceMutation(
    ({ id, input }: { id: string; input: UpdateKioskInput }) =>
      apiFetch(`/kiosks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    true,
  );
}
export function useRevokeKiosk() {
  return useDeviceMutation(
    (id: string) => apiFetch<void>(`/kiosks/${id}`, { method: "DELETE" }),
    true,
  );
}
export function useIssueKioskCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PairingCode>(`/kiosks/${id}/pairing-code`, { method: "POST" }),
    gcTime: 0,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}
