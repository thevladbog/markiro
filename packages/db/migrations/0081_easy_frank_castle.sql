ALTER TABLE "inventory_snapshots" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD COLUMN "line_name" text;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD COLUMN "box_capacity" integer;--> statement-breakpoint
UPDATE "inventory_snapshots" AS "snapshot"
SET "product_name" = CASE
      WHEN "inventory"."status" IN ('running', 'closed', 'completed')
       AND jsonb_typeof("inventory"."station_manifest") = 'object'
       AND jsonb_typeof("inventory"."station_manifest" -> 'productName') = 'string'
       AND char_length("inventory"."station_manifest" ->> 'productName') > 0
      THEN "inventory"."station_manifest" ->> 'productName'
      ELSE "product"."name"
    END,
    "line_name" = CASE
      WHEN "inventory"."status" IN ('running', 'closed', 'completed')
       AND jsonb_typeof("inventory"."station_manifest") = 'object'
       AND jsonb_typeof("inventory"."station_manifest" -> 'lineName') = 'string'
       AND char_length("inventory"."station_manifest" ->> 'lineName') > 0
      THEN "inventory"."station_manifest" ->> 'lineName'
      ELSE "line"."name"
    END,
    "box_capacity" = CASE
      WHEN "inventory"."status" IN ('running', 'closed', 'completed')
       AND jsonb_typeof("inventory"."station_manifest") = 'object'
       AND jsonb_typeof("inventory"."station_manifest" -> 'boxCapacity') = 'number'
      THEN CASE
        WHEN char_length("inventory"."station_manifest" ->> 'boxCapacity') <= 32
         AND ("inventory"."station_manifest" ->> 'boxCapacity') ~ '^[0-9]+([.]0+)?$'
        THEN CASE
          WHEN ("inventory"."station_manifest" ->> 'boxCapacity')::numeric > 0
           AND ("inventory"."station_manifest" ->> 'boxCapacity')::numeric <= 2147483647
           AND trunc(("inventory"."station_manifest" ->> 'boxCapacity')::numeric) =
               ("inventory"."station_manifest" ->> 'boxCapacity')::numeric
          THEN ("inventory"."station_manifest" ->> 'boxCapacity')::numeric::integer
          ELSE "product"."box_capacity"
        END
        ELSE "product"."box_capacity"
      END
      ELSE "product"."box_capacity"
    END
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
