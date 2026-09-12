import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import type {
  DeviceReplacementPreviewRequest,
  DeviceReplacementPreview,
  DeviceReplacementCancel,
} from "@markiro/platform-contracts";
export type Notice = "uncertain" | "conflict" | "authorization" | "saved";
export type Intent = { name: string; kind: "station" | "handheld"; reason: string };
export type PrepareAttempt = {
  intent: Intent;
  request?: DeviceReplacementPreviewRequest;
  preview?: DeviceReplacementPreview;
  pending?: boolean;
  notice?: Notice;
};
export type CancelAttempt = {
  request: DeviceReplacementCancel;
  pending?: boolean;
  notice?: Notice;
};
export const emptyAttempt: PrepareAttempt = { intent: { name: "", kind: "station", reason: "" } };
export const replacementKeys = {
  list: (tenantId: string) => ["device-replacements", tenantId, "list"] as const,
  scope: (tenantId: string) => ["device-replacement-attempt", tenantId] as const,
  prepare: (tenantId: string, sourceId: string) =>
    ["device-replacement-attempt", tenantId, sourceId, "prepare"] as const,
  cancel: (tenantId: string, sourceId: string, preparationId: string) =>
    ["device-replacement-attempt", tenantId, sourceId, "cancel", preparationId] as const,
  selection: (tenantId: string) => ["device-replacement-selection", tenantId] as const,
};
// Query cache owns both identity and the in-flight lock. The originating request
// settles its own cache entry even if its component has unmounted or navigated.
export function useReplacementCache<T>(key: QueryKey, fallback: T) {
  const qc = useQueryClient();
  const subscribe = useCallback((notify: () => void) => qc.getQueryCache().subscribe(notify), [qc]);
  const value = useSyncExternalStore(
    subscribe,
    () => qc.getQueryData<T>(key) ?? fallback,
    () => fallback,
  );
  const set = (next: T) => {
    qc.setQueryDefaults(key, { gcTime: Infinity });
    qc.setQueryData(key, next);
  };
  return [value, set] as const;
}
export function useReplacementPending(tenantId: string) {
  const qc = useQueryClient();
  const subscribe = useCallback((notify: () => void) => qc.getQueryCache().subscribe(notify), [qc]);
  return useSyncExternalStore(
    subscribe,
    () =>
      qc
        .getQueryCache()
        .findAll({ queryKey: replacementKeys.scope(tenantId) })
        .some((query) => {
          const value = query.state.data;
          return (
            typeof value === "object" &&
            value !== null &&
            "pending" in value &&
            value.pending === true
          );
        }),
    () => false,
  );
}
