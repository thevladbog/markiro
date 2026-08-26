ALTER TABLE "inventory_snapshots" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD COLUMN "line_name" text;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD COLUMN "box_capacity" integer;--> statement-breakpoint
UPDATE "inventory_snapshots" AS "snapshot"
SET "product_name" = "product"."name",
    "line_name" = "line"."name",
    "box_capacity" = "product"."box_capacity"
FROM "inventories" AS "inventory"
INNER JOIN "products" AS "product"
  ON "product"."tenant_id" = "inventory"."tenant_id"
 AND "product"."id" = "inventory"."product_id"
INNER JOIN "lines" AS "line"
  ON "line"."tenant_id" = "inventory"."tenant_id"
 AND "line"."id" = "inventory"."line_id"
WHERE "snapshot"."tenant_id" = "inventory"."tenant_id"
  AND "snapshot"."inventory_id" = "inventory"."id";--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ALTER COLUMN "product_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ALTER COLUMN "line_name" SET NOT NULL;
