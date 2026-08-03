import { apiFetch } from "../../api/client.js";

export interface TenantOwnerActivationStatus {
  hasAccount: boolean;
}

export function getTenantOwnerActivationStatus(
  token: string,
): Promise<TenantOwnerActivationStatus> {
  return apiFetch("/tenant-owner-activation/status", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function completeTenantOwnerActivation(token: string, password?: string): Promise<void> {
  return apiFetch("/tenant-owner-activation/complete", {
    method: "POST",
    body: JSON.stringify({ token, ...(password ? { password } : {}) }),
  });
}
