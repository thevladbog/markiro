import { sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { allocateBoxRegistryVersion } from "../boxes/box-registry-version";

export interface ProductGtinVersion {
  tenantId: string;
  productId: string;
  gtin14: string;
}

export function productGtinActuallyChanged(
  before: ProductGtinVersion,
  after: ProductGtinVersion,
): boolean {
  return (
    before.tenantId === after.tenantId &&
    before.productId === after.productId &&
    before.gtin14 !== after.gtin14
  );
}

type ProductRegistryMutationExecutor = Pick<Db, "insert" | "execute">;

/** Stamp only tenant boxes whose eligibility depends on the changed product GTIN. */
export async function invalidateProductGtinRegistry(
  tx: ProductRegistryMutationExecutor,
  tenantId: string,
  productId: string,
): Promise<void> {
  // Avoid materializing an unbounded historical box-id array in Node. The
  // EXISTS preflight prevents a counter-only revision for products with no
  // relevant boxes; the set-based UPDATE stamps every matching box.
  const affected = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1 from ${schema.boxes}
      inner join ${schema.shifts}
        on ${schema.shifts.tenantId} = ${schema.boxes.tenantId}
       and ${schema.shifts.id} = ${schema.boxes.shiftId}
      where ${schema.boxes.tenantId} = ${tenantId}
        and ${schema.shifts.productId} = ${productId}
        and ${schema.boxes.sscc} is not null
        and ${schema.boxes.closedAt} is not null
    ) as exists
  `);
  if (!affected.rows[0]?.exists) return;
  const revision = await allocateBoxRegistryVersion(tx, tenantId);
  await tx.execute(sql`
    update ${schema.boxes}
       set ${schema.boxes.registryVersion} = ${revision},
           ${schema.boxes.updatedAt} = greatest(
             clock_timestamp(),
             ${schema.boxes.updatedAt} + interval '1 millisecond'
           )
      from ${schema.shifts}
     where ${schema.boxes.tenantId} = ${tenantId}
       and ${schema.shifts.tenantId} = ${schema.boxes.tenantId}
       and ${schema.shifts.id} = ${schema.boxes.shiftId}
       and ${schema.shifts.productId} = ${productId}
       and ${schema.boxes.sscc} is not null
       and ${schema.boxes.closedAt} is not null
  `);
}
