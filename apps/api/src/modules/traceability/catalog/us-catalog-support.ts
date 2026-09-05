import { ServiceUnavailableException } from "@nestjs/common";
import type { UsProduct } from "@markiro/platform-contracts";
import { usProductSchema } from "@markiro/platform-contracts";

export type ProductRow = {
  id: string;
  name: string;
  gtin14: string | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function productResponse(row: ProductRow): UsProduct {
  const parsed = usProductSchema.safeParse({
    id: row.id,
    name: row.name,
    gtin14: row.gtin14,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new ServiceUnavailableException({ code: "us_database_unavailable" });
  }
  return parsed.data;
}
