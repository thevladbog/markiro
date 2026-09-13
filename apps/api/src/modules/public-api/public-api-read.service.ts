import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import {
  publicInventorySchema,
  publicProductSchema,
  publicInventoryProgressSchema,
  publicInventoryResultSchema,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { InventoriesService } from "../inventories/inventories.service";
import { InventoryReconciliationService } from "../inventories/inventory-reconciliation.service";
import { PublicApiAuthService } from "./public-api-auth.service";
import {
  PublicApiAdmissionService,
  PUBLIC_API_OPERATIONS,
  type PublicApiOperation,
} from "./public-api-admission.service";
import type { PublicApiPrincipal, PublicApiTransaction } from "./public-api.types";
import {
  publicProjection,
  type PublicProductsQuery,
  type PublicResultsQuery,
} from "./public-api.dto";

const cursorSchema = z
  .object({
    v: z.literal(1),
    tenantId: z.string().uuid(),
    inventoryId: z.string().uuid(),
    classification: z.string().nullable(),
    limit: z.number().int().min(1).max(100),
    page: z.number().int().min(2).max(1000000),
  })
  .strict();
@Injectable()
export class PublicApiReadService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: PublicApiAuthService,
    private readonly admission: PublicApiAdmissionService,
    private readonly inventories: InventoriesService,
    private readonly reconciliation: InventoryReconciliationService,
  ) {}
  private read<T>(
    principal: PublicApiPrincipal,
    operation: PublicApiOperation,
    action: (tx: PublicApiTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        await this.auth.assertCurrent(tx, principal, PUBLIC_API_OPERATIONS[operation].scope);
        await this.admission.assertAllowed(tx, principal.tenantId, operation);
        const result = await action(tx);
        await this.auth.assertCurrent(tx, principal, PUBLIC_API_OPERATIONS[operation].scope);
        await this.admission.assertAllowed(tx, principal.tenantId, operation);
        return result;
      },
      { isolationLevel: "repeatable read" },
    );
  }
  products(principal: PublicApiPrincipal, query: PublicProductsQuery) {
    return this.read(principal, "catalog.read", async (tx) => {
      const conditions = [
        eq(schema.products.tenantId, principal.tenantId),
        eq(schema.products.archived, false),
      ];
      if (query.status) conditions.push(eq(schema.products.status, query.status));
      if (query.search) {
        const search = or(
          ilike(schema.products.name, `%${query.search}%`),
          ilike(schema.products.gtin14, `%${query.search}%`),
        );
        if (search) conditions.push(search);
      }
      const rows = await tx
        .select({
          id: schema.products.id,
          gtin14: schema.products.gtin14,
          name: schema.products.name,
          status: schema.products.status,
          boxCapacity: schema.products.boxCapacity,
        })
        .from(schema.products)
        .where(and(...conditions))
        .orderBy(asc(schema.products.id));
      return { items: rows.map((row) => publicProductSchema.parse(row)) };
    });
  }
  product(principal: PublicApiPrincipal, id: string) {
    return this.read(principal, "catalog.read", async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, principal.tenantId),
            eq(schema.products.id, id),
            eq(schema.products.archived, false),
          ),
        );
      if (!row) throw new NotFoundException();
      return publicProjection(publicProductSchema, row);
    });
  }
  list(principal: PublicApiPrincipal) {
    return this.read(principal, "inventory.read", async (tx) => {
      const rows = await tx
        .select()
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, principal.tenantId))
        .orderBy(asc(schema.inventories.id));
      return {
        items: rows.map((row) =>
          publicProjection(publicInventorySchema, {
            ...row,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }),
        ),
      };
    });
  }
  get(principal: PublicApiPrincipal, id: string) {
    return this.read(principal, "inventory.read", async (tx) =>
      publicProjection(
        publicInventorySchema,
        await this.inventories.get(principal.tenantId, id, tx),
      ),
    );
  }
  progress(principal: PublicApiPrincipal, id: string) {
    return this.read(principal, "inventory.read", async (tx) =>
      publicProjection(
        publicInventoryProgressSchema,
        await this.reconciliation.getProgress(principal.tenantId, id, tx),
      ),
    );
  }
  results(principal: PublicApiPrincipal, id: string, query: PublicResultsQuery) {
    return this.read(principal, "inventory.read", async (tx) => {
      const binding = {
        v: 1 as const,
        tenantId: principal.tenantId,
        inventoryId: id,
        classification: query.classification ?? null,
        limit: query.limit,
      };
      let page = 1;
      if (query.cursor) {
        try {
          if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
          const cursor = cursorSchema.parse(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
          );
          if (
            cursor.tenantId !== binding.tenantId ||
            cursor.inventoryId !== id ||
            cursor.classification !== binding.classification ||
            cursor.limit !== query.limit
          )
            throw new Error();
          page = cursor.page;
        } catch {
          throw new BadRequestException("Invalid or differently bound results cursor");
        }
      }
      const result = await this.reconciliation.listEvidence(
        principal.tenantId,
        id,
        {
          scope: "all",
          page,
          pageSize: query.limit,
          ...(query.classification ? { classification: query.classification } : {}),
        },
        tx,
      );
      return {
        items: result.items.map((row) => publicProjection(publicInventoryResultSchema, row)),
        nextCursor: result.hasMore
          ? Buffer.from(JSON.stringify({ ...binding, page: page + 1 })).toString("base64url")
          : null,
      };
    });
  }
}
