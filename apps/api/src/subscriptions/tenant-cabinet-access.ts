import { ConflictException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export const OFFLINE_TENANT_KIND_ERROR = "catalog_kind_not_allowed_for_offline_tenant";

/**
 * A tenant created without a cabinet may order services, and the plans and
 * add-ons whose catalog item is flagged `offline_available` (spec 2026-10-16).
 * Callers run this inside the transaction that writes. The subscription
 * lifecycle callers hold the tenant subscription timeline lock here, and the
 * cabinet grant takes the same lock before it switches `none` to `enabled`, so
 * for them the check and the grant serialize; they also take the item row
 * FOR SHARE (`lockItem`), so a withdrawal of the flag, which locks the row FOR
 * UPDATE and no tenant lock, serializes with them: lock order is timeline,
 * item, version. Offer and invoice drafts take neither lock; that is still safe
 * for the cabinet because access only moves from `none` to `enabled`, and a
 * stale flag read at most admits a document whose licence is checked again
 * here when it is applied.
 */
export async function assertCatalogAllowedForTenant(
  tx: Pick<Db, "select" | "execute">,
  tenantId: string,
  target: { kind: "plan" | "addon" | "service"; catalogVersionId: string | null },
  options: { lockItem: boolean } = { lockItem: false },
): Promise<void> {
  if (target.kind === "service") return;
  const [tenant] = await tx
    .select({ cabinetAccess: schema.organization.cabinetAccess })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (tenant?.cabinetAccess !== "none") return;
  if (target.catalogVersionId !== null) {
    if (options.lockItem) {
      await tx.execute(sql`
        select item.id from catalog_items item
        join catalog_item_versions version on version.catalog_item_id = item.id
        where version.id = ${target.catalogVersionId} for share of item`);
    }
    const [row] = await tx
      .select({
        offlineAvailable: schema.catalogItems.offlineAvailable,
        kind: schema.catalogItems.kind,
      })
      .from(schema.catalogItemVersions)
      .innerJoin(
        schema.catalogItems,
        eq(schema.catalogItems.id, schema.catalogItemVersions.catalogItemId),
      )
      .where(eq(schema.catalogItemVersions.id, target.catalogVersionId))
      .limit(1);
    if (row?.offlineAvailable === true && row.kind === target.kind) return;
  }
  throw new ConflictException({ code: OFFLINE_TENANT_KIND_ERROR });
}
