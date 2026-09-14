import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { validatePickupKm } from "@markiro/domain";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import { resolveOrderBoxes } from "../pickup-orders/box-order-resolver";
import { createOrderAdmissionSchema, type CreateOrderAdmissionDto } from "../pickup-orders/dto";
import {
  kioskOrderPayloadDigest,
  kioskOrderProcessingLines,
} from "../pickup-orders/kiosk-admission-proof";

/** Caller holds registry root before kiosk row. Never used with task-grant request content. */
export async function freezeKioskOrderScope(
  tx: SubscriptionTransaction,
  tenantId: string,
  kioskId: string,
  input: CreateOrderAdmissionDto,
): Promise<Record<string, unknown> | null> {
  const parsed = createOrderAdmissionSchema.safeParse(input);
  if (!parsed.success) return null;
  const dto = parsed.data;
  const processing = kioskOrderProcessingLines(dto);
  const allowlist = await tx
    .select({ id: schema.products.id, gtin14: schema.products.gtin14 })
    .from(schema.kioskProducts)
    .innerJoin(
      schema.products,
      and(
        eq(schema.products.tenantId, schema.kioskProducts.tenantId),
        eq(schema.products.id, schema.kioskProducts.productId),
        eq(schema.products.archived, false),
      ),
    )
    .where(
      and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, kioskId)),
    )
    .for("share");
  const seen = new Set<string>();
  const items = [];
  for (const item of processing.items) {
    const result = validatePickupKm(item.rawKm);
    if (result.status === "not_km" || result.status === "incomplete") return null;
    const product = allowlist.find((row) => row.gtin14 === result.km.gtin14);
    if (!product || seen.has(result.key)) return null;
    seen.add(result.key);
    items.push({ rawKm: item.rawKm, kmKey: result.key, productId: product.id });
  }
  const resolved = await resolveOrderBoxes(tx, tenantId, processing.boxes);
  if (resolved.conflicts.length) return null;
  const boxes = [];
  for (const box of resolved.boxes) {
    if (!allowlist.some((row) => row.id === box.productId)) return null;
    for (const member of box.members) {
      if (seen.has(member.kmKey)) return null;
      seen.add(member.kmKey);
    }
    boxes.push({
      boxId: box.boxId,
      sscc: box.sscc,
      productId: box.productId,
      members: box.members.map((member) => ({ rawKm: member.rawKm, kmKey: member.kmKey })),
    });
  }
  return {
    version: 1,
    deviceSeq: dto.deviceSeq,
    payloadDigest: kioskOrderPayloadDigest(dto),
    reason: dto.reason,
    writeoffReasonId: dto.writeoffReasonId ?? null,
    // Bind identity without copying the legacy bearer badge value into a new store.
    badgeIdentityDigest: entitlementDigest({
      badgeDigest: dto.badgeDigest ?? null,
      badgeCode: dto.badgeCode ?? null,
    }),
    items,
    boxes,
    unitCount: seen.size,
    containerCount: boxes.length,
  };
}
