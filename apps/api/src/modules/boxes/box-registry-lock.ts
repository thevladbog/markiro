import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";

/** Global lock order root for every box-registry-relevant tenant mutation. */
export async function lockTenantBoxRegistry(
  tx: Pick<Db, "execute">,
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`box-registry:${tenantId}`}, 0))`,
  );
}
