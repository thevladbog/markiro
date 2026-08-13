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

export function buildProductRegistryStampSql(
  tenantId: string,
  productId: string,
  revision: bigint,
) {
  return sql`
    update ${schema.boxes}
       set registry_version = ${revision},
           updated_at = greatest(
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
  `;
}

type ProductRegistryMutationExecutor = Pick<Db, "insert" | "execute">;

/** Stamp only tenant boxes whose eligibility depends on the changed product GTIN. */
export async function invalidateProductGtinRegistry(
  tx: ProductRegistryMutationExecutor,
  tenantId: string,
  productId: string,
): Promise<void> {
  // Every actual GTIN change gets a revision, even with no boxes currently
  // visible. The tenant registry lock makes a concurrent first closure order
  // wholly before or after this revision, eliminating the old EXISTS race.
  const revision = await allocateBoxRegistryVersion(tx, tenantId);
  await tx.execute(buildProductRegistryStampSql(tenantId, productId, revision));
}
