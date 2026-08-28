CREATE SEQUENCE "sscc_blocks_allocation_order_seq";--> statement-breakpoint
ALTER TABLE "sscc_blocks" ADD COLUMN "allocation_order" bigint;--> statement-breakpoint
WITH "ordered_blocks" AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "issued_at", "id") AS "allocation_order"
  FROM "sscc_blocks"
)
UPDATE "sscc_blocks"
SET "allocation_order" = "ordered_blocks"."allocation_order"
FROM "ordered_blocks"
WHERE "sscc_blocks"."id" = "ordered_blocks"."id";--> statement-breakpoint
SELECT setval(
  'sscc_blocks_allocation_order_seq',
  COALESCE(MAX("allocation_order"), 1),
  COUNT(*) > 0
)
FROM "sscc_blocks";--> statement-breakpoint
ALTER TABLE "sscc_blocks" ALTER COLUMN "allocation_order" SET DEFAULT nextval('sscc_blocks_allocation_order_seq'::regclass);--> statement-breakpoint
ALTER TABLE "sscc_blocks" ALTER COLUMN "allocation_order" SET NOT NULL;--> statement-breakpoint
ALTER SEQUENCE "sscc_blocks_allocation_order_seq" OWNED BY "sscc_blocks"."allocation_order";--> statement-breakpoint
CREATE UNIQUE INDEX "sscc_blocks_allocation_order_uq" ON "sscc_blocks" USING btree ("allocation_order");
