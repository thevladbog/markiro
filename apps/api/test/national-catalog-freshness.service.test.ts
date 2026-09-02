import type { Db } from "@markiro/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  DrizzleNationalCatalogFreshnessRepository,
  NationalCatalogFreshnessService,
  type NationalCatalogFreshnessRepository,
} from "../src/modules/national-catalog/national-catalog-freshness.service";
import type { NationalCatalogProductsService } from "../src/modules/national-catalog/national-catalog-products.service";

describe("NationalCatalogFreshnessService", () => {
  it("orders products by their latest source check", async () => {
    let statement: SQL | undefined;
    const db = {
      execute: vi.fn(async (query: SQL) => {
        statement = query;
        return { rows: [] };
      }),
    } as unknown as Db;

    await new DrizzleNationalCatalogFreshnessRepository(db).listDueProducts(50);

    if (!statement) throw new Error("Expected the repository to execute a query");
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql).toContain("order by max(updated_at) asc");
    expect(query.sql).not.toContain("min(last_checked_at)");
  });

  it("processes a bounded batch and isolates tenant failures", async () => {
    const repository: NationalCatalogFreshnessRepository = {
      listDueProducts: vi.fn(async (limit) => {
        expect(limit).toBe(2);
        return [
          { tenantId: "tenant-a", productId: "product-a" },
          { tenantId: "tenant-b", productId: "product-b" },
        ];
      }),
      advanceScheduledAt: vi.fn(async () => undefined),
    };
    const products = {
      lookup: vi.fn(async (tenantId: string) => {
        if (tenantId === "tenant-a") throw new Error("private failure");
        return { outcome: "found", cards: [] };
      }),
    } as unknown as NationalCatalogProductsService;
    const service = new NationalCatalogFreshnessService(repository, products, 2);

    await expect(service.run()).resolves.toEqual({ selected: 2, completed: 1, failed: 1 });
    expect(products.lookup).toHaveBeenCalledTimes(2);
    expect(repository.advanceScheduledAt).toHaveBeenCalledWith(
      "tenant-a",
      "product-a",
      expect.any(Date),
    );
  });

  it("classifies provider and token outcomes as failed without stopping the batch", async () => {
    const repository: NationalCatalogFreshnessRepository = {
      listDueProducts: vi.fn(async () => [
        { tenantId: "tenant-a", productId: "product-a" },
        { tenantId: "tenant-b", productId: "product-b" },
        { tenantId: "tenant-c", productId: "product-c" },
      ]),
      advanceScheduledAt: vi.fn(async () => undefined),
    };
    const products = {
      lookup: vi.fn(async (tenantId: string) => ({
        outcome:
          tenantId === "tenant-a"
            ? ("provider_rate_limited" as const)
            : tenantId === "tenant-b"
              ? ("token_expired" as const)
              : ("empty" as const),
        cards: [],
      })),
    } as unknown as NationalCatalogProductsService;

    await expect(new NationalCatalogFreshnessService(repository, products).run()).resolves.toEqual({
      selected: 3,
      completed: 1,
      failed: 2,
    });
    expect(repository.advanceScheduledAt).toHaveBeenCalledWith(
      "tenant-a",
      "product-a",
      expect.any(Date),
    );
    expect(repository.advanceScheduledAt).toHaveBeenCalledWith(
      "tenant-b",
      "product-b",
      expect.any(Date),
    );
  });
});
