import type { GrantEventType, InventoryEvent } from "@markiro/domain";
/** Payload kind is not the action: repack add-item is an item; open-box is old_box. */
export function inventoryEvidenceKinds(event: InventoryEvent): GrantEventType[] {
  if (event.repack?.action === "add-item") return ["inventory.repack.v1", "inventory.box.close.v1"];
  if (event.repack?.action === "close-incomplete") return ["inventory.box.close.v1"];
  if (event.repack) return [];
  return ["inventory.scan.v1"];
}
