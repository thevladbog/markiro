import { grantEventCost, validatePickupKm } from "@markiro/domain";
import type { CreateOrderDto } from "../api/types.js";
import type { CachedSnapshot } from "../store/cache.js";
import type { StoredBoxRegistryRow, BoxRegistryMeta } from "../store/box-registry.js";
import {
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import { GrantDenied } from "./admission.js";
/** Costs and product membership come from the committed raw order and active registry. */
export function pickupOwnerCost(
  body: CreateOrderDto,
  snapshot: CachedSnapshot,
  rows: StoredBoxRegistryRow[],
  meta: BoxRegistryMeta | null,
  owner: BoxRegistryCredentialOwner | null,
): Record<string, number> {
  const seen = new Set<string>();
  const add = (key: string) => {
    if (seen.has(key)) throw new GrantDenied("wrong_task");
    seen.add(key);
  };
  for (const item of body.items) {
    const result = validatePickupKm(item.rawKm);
    if (
      result.status === "not_km" ||
      result.status === "incomplete" ||
      !snapshot.bootstrap.products.some((p) => p.gtin14 === result.km.gtin14)
    )
      throw new GrantDenied("wrong_task");
    add(result.key);
  }
  if (body.boxes?.length && !sameBoxRegistryCredentialOwner(meta, owner))
    throw new GrantDenied("wrong_owner");
  const boxes = new Set<string>();
  for (const box of body.boxes ?? []) {
    const row = rows.find((value) => value.sscc === box.sscc);
    if (
      !row ||
      boxes.has(box.sscc) ||
      row.contentKeys.length !== row.bottleCount ||
      !snapshot.bootstrap.products.some((p) => p.id === row.productId)
    )
      throw new GrantDenied("wrong_task");
    boxes.add(box.sscc);
    row.contentKeys.forEach(add);
  }
  const cost = grantEventCost("pickup.complete.v1", { units: seen.size, containers: boxes.size });
  if (!cost) throw new GrantDenied("wrong_task");
  return cost;
}
