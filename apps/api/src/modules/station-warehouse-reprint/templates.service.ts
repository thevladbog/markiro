import { Inject, Injectable, PayloadTooLargeException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  WAREHOUSE_REPRINT_PROTOCOL,
  warehouseTemplateSchema,
  productLabelValueDigest,
  type WarehouseTemplateCatalog,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { assertWarehouseDevice } from "./access";

@Injectable()
export class WarehouseTemplatesService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async templates(
    tenantId: string,
    deviceId: string,
    ids?: readonly string[],
  ): Promise<WarehouseTemplateCatalog> {
    await assertWarehouseDevice(this.db, tenantId, deviceId);
    const rows = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(
        and(
          eq(schema.labelTemplates.tenantId, tenantId),
          eq(schema.labelTemplates.enabled, true),
          inArray(schema.labelTemplates.purpose, ["box", "product_duplicate"]),
          ids === undefined ? undefined : inArray(schema.labelTemplates.id, [...ids]),
        ),
      )
      .orderBy(asc(schema.labelTemplates.name), asc(schema.labelTemplates.id))
      .limit(1001);
    if (rows.length > 1000)
      throw new PayloadTooLargeException({ code: "WAREHOUSE_TEMPLATE_CATALOG_TOO_LARGE" });
    const templates = rows.flatMap((row) => {
      const value = {
        id: row.id,
        revision: productLabelValueDigest({
          id: row.id,
          updatedAt: row.updatedAt.toISOString(),
          spec: row.spec,
          name: row.name,
          purpose: row.purpose,
          enabled: row.enabled,
          chzProductGroupCodes: row.chzProductGroupCodes,
        }),
        name: row.name,
        purpose: row.purpose,
        enabled: row.enabled,
        chzProductGroupCodes: row.chzProductGroupCodes,
        spec: row.spec,
      };
      const result = warehouseTemplateSchema.safeParse({
        ...value,
        digest: productLabelValueDigest(value),
      });
      return result.success ? [result.data] : [];
    });
    return {
      protocol: WAREHOUSE_REPRINT_PROTOCOL,
      revision: productLabelValueDigest(templates),
      templates,
    };
  }
}
