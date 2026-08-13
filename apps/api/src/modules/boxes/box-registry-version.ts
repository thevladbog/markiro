import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export type BoxRegistryMutationExecutor = Pick<Db, "insert" | "update">;

/**
 * Allocates one committed tenant revision and stamps exactly the changed boxes
 * in the caller's transaction. PostgreSQL serializes concurrent upserts on the
 * tenant primary key; the counter and box rows become visible atomically at
 * commit, so a reader of currentVersion can never advertise an uncommitted box
 * revision. An absent row is the lazy-new-tenant case and starts at revision 1.
 */
export async function advanceBoxRegistryVersion(
  tx: BoxRegistryMutationExecutor,
  tenantId: string,
  boxIds: Iterable<string>,
): Promise<bigint | null> {
  const changedBoxIds = [...new Set(boxIds)].sort();
  if (changedBoxIds.length === 0) return null;

  const [counter] = await tx
    .insert(schema.boxRegistryVersions)
    .values({ tenantId, currentVersion: 1n, updatedAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({
      target: schema.boxRegistryVersions.tenantId,
      set: {
        currentVersion: sql`${schema.boxRegistryVersions.currentVersion} + 1`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({ currentVersion: schema.boxRegistryVersions.currentVersion });
  if (!counter) throw new Error("Box registry revision allocation returned no row");

  await tx
    .update(schema.boxes)
    .set({
      registryVersion: counter.currentVersion,
      updatedAt: sql`GREATEST(clock_timestamp(), ${schema.boxes.updatedAt} + interval '1 millisecond')`,
    })
    .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.id, changedBoxIds)));
  return counter.currentVersion;
}
