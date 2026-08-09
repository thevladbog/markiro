import { sql } from "drizzle-orm";
import type { SubscriptionTransaction } from "./entitlements.types";

export async function lockTenantSubscriptionTimeline(
  tx: SubscriptionTransaction,
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-subscription:${tenantId}`}, 0))`,
  );
}
