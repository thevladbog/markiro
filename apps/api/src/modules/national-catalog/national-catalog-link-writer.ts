import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { DbTx, ImportActor } from "./national-catalog-import.types";
/** Caller holds the product lock. The same closure/audit is used for remove, replacement and GTIN detach. */
export async function closeNationalCatalogLinkInTransaction(
  tx: DbTx,
  actor: ImportActor,
  productId: string,
  expectedRevision: number,
  reason: "removed" | "replaced" | "gtin_changed",
) {
  const [link] = await tx
    .select()
    .from(schema.nationalCatalogProductLinks)
    .where(
      and(
        eq(schema.nationalCatalogProductLinks.tenantId, actor.tenantId),
        eq(schema.nationalCatalogProductLinks.productId, productId),
        isNull(schema.nationalCatalogProductLinks.closedAt),
      ),
    )
    .for("update");
  if (!link) throw new NotFoundException("national_catalog_link_not_found");
  if (link.revision !== expectedRevision) throw new ConflictException("link_changed");
  const now = new Date();
  await tx
    .update(schema.nationalCatalogProductLinks)
    .set({
      closedBy: actor.userId,
      closedAt: now,
      closedReason: reason,
      revision: link.revision + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nationalCatalogProductLinks.tenantId, actor.tenantId),
        eq(schema.nationalCatalogProductLinks.id, link.id),
      ),
    );
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: actor.tenantId,
    actorUserId: actor.userId,
    action: "national_catalog.link.removed",
    outcome: "success",
    targetType: "product",
    targetId: productId,
    before: {
      linkId: link.id,
      revision: link.revision,
      cardId: link.cardId,
      environment: link.environment,
      boundGtin14: link.boundGtin14,
    },
    after: { reason, revision: link.revision + 1, closedAt: now.toISOString() },
  });
  return link;
}
