import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { projectCommercialResponse, type CommercialVersion } from "./commercial-version";

/** Call inside the mutation owner's transaction, after its existing locks.
 * This checks representation only; ownership, existence and status retain their owners.
 * Saved document replay/payment paths deliberately do not use this new-selection check.
 */
export async function assertCatalogCommercialCompatibility(
  tx: Pick<Db, "select">,
  versionId: string,
  clientVersion: CommercialVersion,
): Promise<void> {
  if (clientVersion === 3) return;
  const [version] = await tx
    .select()
    .from(schema.catalogItemVersions)
    .where(eq(schema.catalogItemVersions.id, versionId))
    .for("share");
  if (!version) return;
  projectCommercialResponse(clientVersion, { lifecyclePolicyId: version.lifecyclePolicyId });
  if (version.kind === "plan") {
    const [plan] = await tx
      .select()
      .from(schema.planEntitlements)
      .where(eq(schema.planEntitlements.catalogVersionId, versionId));
    projectCommercialResponse(clientVersion, plan);
  } else if (version.kind === "addon") {
    const effects = await tx
      .select()
      .from(schema.addonEntitlements)
      .where(eq(schema.addonEntitlements.catalogVersionId, versionId));
    projectCommercialResponse(clientVersion, effects);
  }
}
