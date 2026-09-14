import type { InventoryChzStatus } from "@markiro/domain";
import type { ChzContainerKind } from "./chz-tabular-reader";

/** Every new attempt owns its object; cleanup cannot delete a deduplicated winner. */
export function inventoryImportObjectKey(input: {
  tenantId: string;
  inventoryId: string;
  status: InventoryChzStatus;
  sha256: string;
  containerKind: ChzContainerKind;
  importId: string;
  publicActor: boolean;
}): string {
  const prefix = `tenants/${input.tenantId}/inventories/${input.inventoryId}/imports/${input.status}/`;
  const owner = `${input.publicActor ? "public" : "attempt"}/${input.importId}/`;
  return `${prefix}${owner}${input.sha256}.${input.containerKind}`;
}

/** Read-only compatibility for historical cabinet evidence; never used for new writes. */
export function legacyCabinetInventoryImportObjectKey(input: {
  tenantId: string;
  inventoryId: string;
  status: InventoryChzStatus;
  sha256: string;
  containerKind: ChzContainerKind;
}): string {
  return `tenants/${input.tenantId}/inventories/${input.inventoryId}/imports/${input.status}/${input.sha256}.${input.containerKind}`;
}
