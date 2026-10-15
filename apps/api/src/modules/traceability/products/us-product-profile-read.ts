import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, type ProductTraceabilityProfile } from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { orderedMasterDataRows, parseMasterDataIds } from "../master-data/us-master-data-batch";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { profileDefaults, storedProfileResponse } from "./us-product-profile-support";

type ProductIdentity = { id: string; name: string };
type ProfileRow = typeof schema.productTraceabilityProfiles.$inferSelect;
type Lock = "share" | "update";

export type UsProductProfileReaders = Readonly<{
  authorize: typeof authorizeUsMasterData;
  product(
    tx: UsMasterDataTransaction,
    tenantId: string,
    productId: string,
    lock: Lock,
  ): Promise<ProductIdentity | undefined>;
  profile(
    tx: UsMasterDataTransaction,
    tenantId: string,
    productId: string,
  ): Promise<ProfileRow | undefined>;
  products(
    tx: UsMasterDataTransaction,
    tenantId: string,
    ids: readonly string[],
  ): Promise<ProductIdentity[]>;
  profiles(
    tx: UsMasterDataTransaction,
    tenantId: string,
    ids: readonly string[],
  ): Promise<ProfileRow[]>;
}>;

async function freshProduct(
  tx: UsMasterDataTransaction,
  tenantId: string,
  productId: string,
  lock: Lock,
) {
  const [product] = await tx
    .select({ id: schema.products.id, name: schema.products.name })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
    .limit(1)
    .for(lock);
  return product;
}

async function freshProfile(tx: UsMasterDataTransaction, tenantId: string, productId: string) {
  const [row] = await tx
    .select()
    .from(schema.productTraceabilityProfiles)
    .where(
      and(
        eq(schema.productTraceabilityProfiles.tenantId, tenantId),
        eq(schema.productTraceabilityProfiles.productId, productId),
      ),
    )
    .limit(1);
  return row;
}

async function freshProducts(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: readonly string[],
) {
  return tx
    .select({ id: schema.products.id, name: schema.products.name })
    .from(schema.products)
    .where(
      and(
        eq(schema.products.tenantId, tenantId),
        inArray(schema.products.id, [...new Set(ids)].sort()),
      ),
    )
    .orderBy(asc(schema.products.id))
    .for("share");
}

async function freshProfiles(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: readonly string[],
) {
  return tx
    .select()
    .from(schema.productTraceabilityProfiles)
    .where(
      and(
        eq(schema.productTraceabilityProfiles.tenantId, tenantId),
        inArray(schema.productTraceabilityProfiles.productId, [...ids]),
      ),
    );
}

export const freshUsProductProfileReaders: UsProductProfileReaders = {
  authorize: authorizeUsMasterData,
  product: freshProduct,
  profile: freshProfile,
  products: freshProducts,
  profiles: freshProfiles,
};

export async function readCurrentUsProductProfile(
  tx: UsMasterDataTransaction,
  tenantId: string,
  productId: string,
  profileCode: string,
  lock: Lock,
  readers: UsProductProfileReaders,
): Promise<ProductTraceabilityProfile> {
  const product = await readers.product(tx, tenantId, productId, lock);
  if (!product) throw new NotFoundException({ code: "product_not_found" });
  const row = await readers.profile(tx, tenantId, productId);
  return row ? storedProfileResponse(row, profileCode) : profileDefaults(product);
}

export async function readUsProductProfileCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  inputId: unknown,
  readers: UsProductProfileReaders,
): Promise<ProductTraceabilityProfile> {
  const productId = parseMasterDataInput(platformUuidSchema, inputId);
  const profileCode = await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  return readCurrentUsProductProfile(tx, tenantId, productId, profileCode, "share", readers);
}

export async function readUsProductProfilesCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  inputIds: unknown,
  readers: UsProductProfileReaders,
): Promise<ProductTraceabilityProfile[]> {
  const ids = parseMasterDataIds(inputIds);
  const profileCode = await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  if (ids.length === 0) return [];
  const products = await readers.products(tx, tenantId, ids);
  const ordered = orderedMasterDataRows(ids, products, (row) => row.id, "product_not_found");
  const rows = await readers.profiles(tx, tenantId, ids);
  const byProduct = new Map(rows.map((row) => [row.productId, row]));
  return ordered.map((product) => {
    const row = byProduct.get(product.id);
    return row ? storedProfileResponse(row, profileCode) : profileDefaults(product);
  });
}
