LOCK TABLE "sscc_blocks" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "sscc_blocks" ALTER COLUMN "allocation_order" DROP DEFAULT;--> statement-breakpoint
DROP INDEX IF EXISTS "sscc_blocks_allocation_order_uq";--> statement-breakpoint
WITH "ordered_blocks" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tenant_id", "issuer_prefix", "extension_digit", "device_id"
      ORDER BY "issued_at", "allocation_order", "id"
    ) AS "allocation_order"
  FROM "sscc_blocks"
)
UPDATE "sscc_blocks"
SET "allocation_order" = "ordered_blocks"."allocation_order"
FROM "ordered_blocks"
WHERE "sscc_blocks"."id" = "ordered_blocks"."id";--> statement-breakpoint
CREATE UNIQUE INDEX "sscc_blocks_stream_allocation_order_uq" ON "sscc_blocks" USING btree ("tenant_id","issuer_prefix","extension_digit","device_id","allocation_order");--> statement-breakpoint
ALTER SEQUENCE IF EXISTS "sscc_blocks_allocation_order_seq" OWNED BY NONE;--> statement-breakpoint
DROP SEQUENCE IF EXISTS "sscc_blocks_allocation_order_seq";
