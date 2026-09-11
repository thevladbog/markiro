import { useQuery } from "@tanstack/react-query";
import { entitlementSnapshotV1Schema } from "@markiro/platform-contracts";
import { apiFetch } from "../../api/client.js";
export async function getBillingEntitlements() {
  return entitlementSnapshotV1Schema.parse(await apiFetch<unknown>("/access/entitlements"));
}
export function useBillingEntitlements() {
  return useQuery({ queryKey: ["billing", "entitlements"], queryFn: getBillingEntitlements });
}
