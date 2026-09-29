import { ConflictException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export const OFFLINE_TENANT_KIND_ERROR = "catalog_kind_not_allowed_for_offline_tenant";

/**
 * A tenant created without a cabinet may only order services. Licences (plan,
 * add-on) grant entitlements to a cabinet that does not exist for it. Callers
 * run this inside the transaction that writes, so a concurrent grant of the
 * cabinet cannot slip a licence in between check and write.
 */
export async function assertKindAllowedForTenant(
  tx: Pick<Db, "select">,
  tenantId: string,
  kind: "plan" | "addon" | "service",
): Promise<void> {
  if (kind === "service") return;
  const [tenant] = await tx
    .select({ cabinetAccess: schema.organization.cabinetAccess })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (tenant?.cabinetAccess === "none") {
    throw new ConflictException({ code: OFFLINE_TENANT_KIND_ERROR });
  }
}
