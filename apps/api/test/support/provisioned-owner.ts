import type { TenantProvisioningResult } from "../../src/modules/platform-tenants/tenant-provisioning.service";

export interface ProvisionedOwner {
  tenantId: string;
  userId: string;
  memberId: string;
  deliveryId: string;
}

/**
 * Narrows a provisioning result to one with a cabinet owner. Tenants created
 * with cabinet access have an owner, a member and an activation delivery;
 * only a tenant without cabinet returns nulls, which these callers never
 * provision.
 */
export function requireOwner(result: TenantProvisioningResult): ProvisionedOwner {
  const { tenantId, userId, memberId, deliveryId } = result;
  if (userId === null || memberId === null || deliveryId === null) {
    throw new Error("expected a provisioned cabinet owner");
  }
  return { tenantId, userId, memberId, deliveryId };
}
