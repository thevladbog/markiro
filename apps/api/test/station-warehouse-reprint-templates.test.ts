import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { warehouseBoxTemplate, warehouseTemplateCatalogSchema } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { WarehouseTemplatesService } from "../src/modules/station-warehouse-reprint/templates.service";
import * as controller from "../src/modules/station-warehouse-reprint/controller";

function reader(authorized = true) {
  const conditions: { sql: string; params: unknown[] }[] = [];
  const box = warehouseBoxTemplate();
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          const index = conditions.push(new PgDialect().sqlToQuery(condition));
          return index === 1
            ? Promise.resolve(authorized ? [{ id: randomUUID() }] : [])
            : {
                orderBy: () => ({
                  limit: () => Promise.resolve([{ ...box, updatedAt: new Date("2026-10-09") }]),
                }),
              };
        },
      }),
    }),
  } as unknown as Db;
  return { db, conditions, box };
}

describe("warehouse template reads", () => {
  it("validates a bounded comma-separated UUID filter and rejects injected query scope", () => {
    const id = randomUUID();
    expect(controller.warehouseTemplateIdsQuerySchema.parse({ ids: `${id},${id}` })).toEqual({
      ids: [id],
    });
    expect(controller.warehouseTemplateIdsQuerySchema.parse({})).toEqual({});
    for (const input of [
      { ids: "" },
      { ids: "not-a-uuid" },
      { ids: [id] },
      { ids: Array.from({ length: 21 }, () => randomUUID()).join(",") },
      { tenantId: randomUUID() },
    ]) {
      expect(controller.warehouseTemplateIdsQuerySchema.safeParse(input).success).toBe(false);
    }
  });
  it("limits selected reads in SQL while retaining enabled tenant and purpose boundaries", async () => {
    const { db, conditions, box } = reader();
    const tenantId = randomUUID();
    const deviceId = randomUUID();
    const result = await new WarehouseTemplatesService(db).templates(tenantId, deviceId, [box.id]);
    expect(conditions[0]?.params).toEqual([tenantId, deviceId, "station"]);
    expect(conditions[1]?.params).toEqual([tenantId, true, "box", "product_duplicate", box.id]);
    expect(conditions[1]?.sql).toContain('"label_templates"."id" in');
    expect(warehouseTemplateCatalogSchema.parse(result).templates.map((t) => t.id)).toEqual([
      box.id,
    ]);
    expect(Object.keys(result).sort()).toEqual(["protocol", "revision", "templates"]);
  });

  it("keeps unfiltered v1 catalog reads unchanged", async () => {
    const { db, conditions } = reader();
    const tenantId = randomUUID();
    await new WarehouseTemplatesService(db).templates(tenantId, randomUUID());
    expect(conditions[1]?.params).toEqual([tenantId, true, "box", "product_duplicate"]);
    expect(conditions[1]?.sql).not.toContain('"label_templates"."id" in');
  });

  it("denies a revoked, handheld or foreign device before reading any templates", async () => {
    const { db, conditions, box } = reader(false);
    await expect(
      new WarehouseTemplatesService(db).templates(randomUUID(), randomUUID(), [box.id]),
    ).rejects.toThrow("Forbidden");
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.sql).toContain('"station_devices"."revoked_at" is null');
  });
});
