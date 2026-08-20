import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { lockTenantBoxRegistry } from "../boxes/box-registry-lock";

/**
 * Global order for pickup writes: tenant registry root -> employee/day
 * allowance. Station and product writers only take the first root and never
 * request a pickup lock, so no reverse edge exists.
 *
 * The tenant registry root is taken for EVERY order, not just box-bearing
 * ones: `validateBoxCandidates` (disaggregation's line revalidation, and the
 * box registry's own candidate classification) marks a box `written_off`
 * from a code-level lock too -- `pickup_order_items` rows reconstructed onto
 * a box's live km_keys, not just `pickup_order_boxes` rows -- so a loose
 * item-only order can make a box ineligible for disaggregation just as
 * surely as a box-level one. Disaggregation's `applyDocument` revalidates
 * and then mutates boxes under this exact lock root; an item-only order that
 * skipped it could still commit in the gap between that revalidation read
 * and the disassemble writes, silently locking codes on a box that apply is
 * about to retire. So every pickup-order transaction serializes with the
 * box registry lock, box-bearing or not.
 */
export async function lockPickupOrderTransaction(
  tx: Pick<Db, "execute">,
  input: {
    tenantId: string;
    employeeId: string;
    utcDay: string;
  },
): Promise<void> {
  await lockTenantBoxRegistry(tx, input.tenantId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`pickup-limit:${input.tenantId}:${input.employeeId}:${input.utcDay}`}, 0))`,
  );
}
