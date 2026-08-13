import { sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export interface MembershipRow {
  boxId: string;
  codeHash: string;
  addedAt: Date;
  ownerIsThisScan: boolean;
}

/**
 * Exact box-item rows that must be marked displaced.
 *
 * Aggregation follows ownership: 06b's rule is that the earlier scannedAt
 * owns the code, and a box may only count what its own scan owns. The item
 * is MARKED, never deleted — it is the only evidence that two terminals
 * boxed what is physically one item.
 */
export function displacedMemberships(rows: MembershipRow[]): MembershipRow[] {
  return rows.filter((row) => !row.ownerIsThisScan);
}

/**
 * Inserts losing memberships already inactive and reports only rows newly
 * created by this delivery. Exact conflict/replay rows return nothing, so
 * callers can advance registry revisions without false-positive restamps.
 */
export async function insertFreshDisplacedMemberships(
  tx: Pick<Db, "insert">,
  tenantId: string,
  rows: readonly MembershipRow[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await tx
    .insert(schema.boxItems)
    .values(
      rows.map((row) => ({
        tenantId,
        boxId: row.boxId,
        codeHash: row.codeHash,
        addedAt: row.addedAt,
        displacedAt: sql`now()`,
      })),
    )
    .onConflictDoNothing()
    .returning({ boxId: schema.boxItems.boxId });
  return inserted.map((row) => row.boxId);
}
