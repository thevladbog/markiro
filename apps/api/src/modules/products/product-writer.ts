import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DomainError, normalizeToGtin14 } from "@markiro/domain";
import type { CreateProductDto, ProductStatus } from "./dto";
type ProductAuditTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export class ProductWriter {
  async createInTransaction(
    tx: ProductAuditTx,
    tenantId: string,
    data: CreateProductDto,
  ): Promise<string> {
    const gtin14 = this.normalizeOrThrow(data.gtin);
    const chzProductGroupCode = data.chzProductGroupCode ?? null;
    const boxCapacity = data.boxCapacity ?? null;
    const palletBoxCapacity = data.palletBoxCapacity ?? null;
    const status = this.computeStatus({ chzProductGroupCode, boxCapacity, palletBoxCapacity });

    const [row] = await tx
      .insert(schema.products)
      .values({
        tenantId,
        gtin14,
        name: data.name,
        chzProductGroupCode,
        boxCapacity,
        palletBoxCapacity,
        status,
        archived: data.archived ?? false,
        defaultCounterpartyId: data.defaultCounterpartyId ?? null,
        unitPrice: data.unitPrice ?? null,
        printName: data.printName ?? null,
        egaisCode: data.egaisCode ?? null,
        shelfLifeDays: data.shelfLifeDays ?? null,
        externalRef: data.externalRef ?? null,
      })
      .returning({ id: schema.products.id });
    if (!row) throw new InternalServerErrorException("Failed to create product");
    await this.replaceLegacyEgaisCode(tx, tenantId, row.id, data.egaisCode ?? null);
    return row.id;
  }
  async replaceLegacyEgaisCode(
    tx: ProductAuditTx,
    tenantId: string,
    productId: string,
    code: string | null,
  ): Promise<void> {
    if (code !== null && !/^\d{19}$/.test(code)) {
      throw new BadRequestException({ code: "EGAIS_CODE_INVALID" });
    }
    await tx
      .delete(schema.productEgaisCodes)
      .where(
        and(
          eq(schema.productEgaisCodes.tenantId, tenantId),
          eq(schema.productEgaisCodes.productId, productId),
        ),
      );
    if (code !== null) {
      await tx.insert(schema.productEgaisCodes).values({
        tenantId,
        productId,
        code,
        isPrimary: true,
        source: "manual",
      });
    }
  }

  /** Caller holds the product lock. Preserve alternate codes when choosing a new primary. */
  async importPrimaryEgaisCode(
    tx: ProductAuditTx,
    tenantId: string,
    productId: string,
    code: string,
    sourceRef: string,
    observedAt: Date,
  ): Promise<void> {
    if (!/^\d{19}$/.test(code)) throw new BadRequestException({ code: "EGAIS_CODE_INVALID" });
    const codes = await tx
      .select({ code: schema.productEgaisCodes.code })
      .from(schema.productEgaisCodes)
      .where(
        and(
          eq(schema.productEgaisCodes.tenantId, tenantId),
          eq(schema.productEgaisCodes.productId, productId),
        ),
      );
    if (codes.length >= 20 && !codes.some((row) => row.code === code))
      throw new ConflictException("product_changed");
    const appliedAt = new Date();
    await tx
      .update(schema.productEgaisCodes)
      .set({ isPrimary: false })
      .where(
        and(
          eq(schema.productEgaisCodes.tenantId, tenantId),
          eq(schema.productEgaisCodes.productId, productId),
          eq(schema.productEgaisCodes.isPrimary, true),
        ),
      );
    await tx
      .insert(schema.productEgaisCodes)
      .values({
        tenantId,
        productId,
        code,
        isPrimary: true,
        source: "national_catalog",
        sourceRef,
        observedAt,
        appliedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.productEgaisCodes.tenantId,
          schema.productEgaisCodes.productId,
          schema.productEgaisCodes.code,
        ],
        set: { isPrimary: true, source: "national_catalog", sourceRef, observedAt, appliedAt },
      });
    await tx
      .update(schema.products)
      .set({ egaisCode: code })
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
  }

  normalizeOrThrow(gtin: string): string {
    try {
      return normalizeToGtin14(gtin);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  computeStatus(fields: {
    chzProductGroupCode: number | null;
    boxCapacity: number | null;
    palletBoxCapacity: number | null;
  }): ProductStatus {
    return fields.chzProductGroupCode !== null &&
      fields.boxCapacity !== null &&
      fields.palletBoxCapacity !== null
      ? "active"
      : "draft";
  }
}
