import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { lockTenantBoxRegistry } from "../boxes/box-registry-lock";

/**
 * Global order for box-bearing pickup writes:
 * tenant registry root -> employee/day allowance. Station and product writers
 * only take the first root and never request a pickup lock, so no reverse edge
 * exists. Loose-only legacy orders deliberately skip the tenant-wide root.
 */
export async function lockPickupOrderTransaction(
  tx: Pick<Db, "execute">,
  input: {
    tenantId: string;
    employeeId: string;
    utcDay: string;
    hasBoxes: boolean;
  },
): Promise<void> {
  if (input.hasBoxes) await lockTenantBoxRegistry(tx, input.tenantId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`pickup-limit:${input.tenantId}:${input.employeeId}:${input.utcDay}`}, 0))`,
  );
}
