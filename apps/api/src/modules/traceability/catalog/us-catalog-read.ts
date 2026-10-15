import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, type UsProduct } from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { orderedMasterDataRows, parseMasterDataIds } from "../master-data/us-master-data-batch";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { productResponse, type ProductRow } from "./us-catalog-support";

export const productColumns = {
  id: schema.products.id,
  name: schema.products.name,
  gtin14: schema.products.gtin14,
  archived: schema.products.archived,
  createdAt: schema.products.createdAt,
  updatedAt: schema.products.updatedAt,
};

export type UsCatalogReaders = Readonly<{
  authorize: typeof authorizeUsMasterData;
  product(
    tx: UsMasterDataTransaction,
    tenantId: string,
    id: string,
  ): Promise<ProductRow | undefined>;
  products(
    tx: UsMasterDataTransaction,
    tenantId: string,
    ids: readonly string[],
  ): Promise<ProductRow[]>;
}>;

async function freshProduct(tx: UsMasterDataTransaction, tenantId: string, id: string) {
  const [row] = await tx
    .select(productColumns)
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)))
    .limit(1);
  return row;
}

async function freshProducts(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: readonly string[],
) {
  return tx
    .select(productColumns)
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), inArray(schema.products.id, [...ids])));
}

export const freshUsCatalogReaders: UsCatalogReaders = {
  authorize: authorizeUsMasterData,
  product: freshProduct,
  products: freshProducts,
};

export async function readUsProductCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  readers: UsCatalogReaders,
): Promise<UsProduct> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const productId = parseMasterDataInput(platformUuidSchema, id);
  const row = await readers.product(tx, tenantId, productId);
  if (!row) throw new NotFoundException({ code: "product_not_found" });
  return productResponse(row);
}

export async function readUsProductsCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  inputIds: unknown,
  readers: UsCatalogReaders,
): Promise<UsProduct[]> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const ids = parseMasterDataIds(inputIds);
  if (ids.length === 0) return [];
  const rows = await readers.products(tx, tenantId, ids);
  return orderedMasterDataRows(ids, rows, (row) => row.id, "product_not_found").map(
    productResponse,
  );
}
