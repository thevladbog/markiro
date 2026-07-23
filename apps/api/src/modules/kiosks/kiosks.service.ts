import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { generateDeviceToken, hashDeviceToken } from "../../pickup/device-token";
import type {
  CreateKioskDto, EnrollKioskResponseDto, KioskDto,
  ListKiosksResponseDto, SetKioskProductsDto, UpdateKioskDto,
} from "./dto";

type KioskRow = typeof schema.kiosks.$inferSelect;

@Injectable()
export class KiosksService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listKiosks(tenantId: string): Promise<ListKiosksResponseDto> {
    const rows = await this.db.select().from(schema.kiosks)
      .where(eq(schema.kiosks.tenantId, tenantId)).orderBy(schema.kiosks.name);
    const productIds = await this.productIdsFor(tenantId, rows.map((r) => r.id));
    return { items: rows.map((r) => this.toDto(r, productIds.get(r.id) ?? [])) };
  }

  async createKiosk(tenantId: string, dto: CreateKioskDto): Promise<KioskDto> {
    const [row] = await this.db.insert(schema.kiosks).values({
      tenantId,
      name: dto.name,
      location: dto.location ?? null,
      dayLimitPerEmployee: dto.dayLimitPerEmployee,
      showPrices: dto.showPrices,
    }).returning();
    return this.toDto(row!, []);
  }

  async updateKiosk(tenantId: string, id: string, dto: UpdateKioskDto): Promise<KioskDto> {
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.location !== undefined) set.location = dto.location;
    if (dto.dayLimitPerEmployee !== undefined) set.dayLimitPerEmployee = dto.dayLimitPerEmployee;
    if (dto.showPrices !== undefined) set.showPrices = dto.showPrices;
    if (dto.status !== undefined) set.status = dto.status;

    if (Object.keys(set).length === 0) {
      const row = await this.findRow(tenantId, id);
      if (!row) throw new NotFoundException();
      return this.toDto(row, await this.productIdsForOne(tenantId, id));
    }

    const [row] = await this.db.update(schema.kiosks).set(set)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id))).returning();
    if (!row) throw new NotFoundException();
    return this.toDto(row, await this.productIdsForOne(tenantId, id));
  }

  async archiveKiosk(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db.update(schema.kiosks).set({ status: "archived" })
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id))).returning();
    if (!row) throw new NotFoundException();
  }

  async setProducts(tenantId: string, id: string, dto: SetKioskProductsDto): Promise<KioskDto> {
    const row = await this.findRow(tenantId, id);
    if (!row) throw new NotFoundException();

    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(schema.kioskProducts)
          .where(and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, id)));
        if (dto.productIds.length > 0) {
          await tx.insert(schema.kioskProducts).values(
            dto.productIds.map((productId) => ({ tenantId, kioskId: id, productId })),
          );
        }
      });
    } catch (error) {
      this.handleWriteError(error);
    }

    return this.toDto(row, await this.productIdsForOne(tenantId, id));
  }

  async enroll(tenantId: string, id: string): Promise<EnrollKioskResponseDto> {
    const row = await this.findRow(tenantId, id);
    if (!row) throw new NotFoundException();

    const token = generateDeviceToken();
    await this.db.update(schema.kiosks).set({ deviceTokenHash: hashDeviceToken(token) })
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
    return { token };
  }

  private async findRow(tenantId: string, id: string): Promise<KioskRow | undefined> {
    const [row] = await this.db.select().from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
    return row;
  }

  private async productIdsForOne(tenantId: string, kioskId: string): Promise<string[]> {
    const map = await this.productIdsFor(tenantId, [kioskId]);
    return map.get(kioskId) ?? [];
  }

  private async productIdsFor(tenantId: string, kioskIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (kioskIds.length === 0) return map;
    const rows = await this.db.select().from(schema.kioskProducts)
      .where(eq(schema.kioskProducts.tenantId, tenantId));
    const idSet = new Set(kioskIds);
    for (const r of rows) {
      if (!idSet.has(r.kioskId)) continue;
      const list = map.get(r.kioskId) ?? [];
      list.push(r.productId);
      map.set(r.kioskId, list);
    }
    return map;
  }

  /** 23503 on kiosk_products_tenant_product_fk -> 400 (unknown/foreign-tenant product). */
  private handleWriteError(error: unknown): never {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;

    if (errorCode === "23503" && constraint === "kiosk_products_tenant_product_fk") {
      throw new BadRequestException("Unknown product for this organization");
    }
    throw error;
  }

  private toDto(row: KioskRow, productIds: string[]): KioskDto {
    return {
      id: row.id,
      name: row.name,
      location: row.location,
      dayLimitPerEmployee: row.dayLimitPerEmployee,
      showPrices: row.showPrices,
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      enrolled: row.deviceTokenHash !== null,
      productIds,
      createdAt: row.createdAt,
    };
  }
}
