import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
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
    const palletCapacity = data.palletCapacity ?? null;
    const status = this.computeStatus({ chzProductGroupCode, boxCapacity, palletCapacity });

    const [row] = await tx
      .insert(schema.products)
      .values({
        tenantId,
        gtin14,
        name: data.name,
        chzProductGroupCode,
        boxCapacity,
        palletCapacity,
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
    palletCapacity: number | null;
  }): ProductStatus {
    return fields.chzProductGroupCode !== null &&
      fields.boxCapacity !== null &&
      fields.palletCapacity !== null
      ? "active"
      : "draft";
  }
}
