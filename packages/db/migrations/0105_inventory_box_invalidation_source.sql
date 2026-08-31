CREATE TYPE "public"."inventory_repack_invalidation_source" AS ENUM('claim_lost', 'admin');--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD COLUMN "invalidation_source" "inventory_repack_invalidation_source";--> statement-breakpoint
UPDATE "inventory_repack_boxes" "box"
   SET "invalidation_source" = CASE
     WHEN EXISTS (
       SELECT 1
         FROM "inventory_corrections" "correction"
        WHERE "correction"."tenant_id" = "box"."tenant_id"
          AND "correction"."inventory_id" = "box"."inventory_id"
          AND "correction"."target_repack_box_id" = "box"."id"
          AND "correction"."action" = 'invalidate_box'
     ) THEN 'admin'::"public"."inventory_repack_invalidation_source"
     ELSE 'claim_lost'::"public"."inventory_repack_invalidation_source"
   END
 WHERE "box"."state" = 'invalidated'
   AND "box"."invalidation_source" IS NULL;--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_invalidation_source_check" CHECK (("inventory_repack_boxes"."state" = 'invalidated' and "inventory_repack_boxes"."invalidation_source" is not null)
        or ("inventory_repack_boxes"."state" <> 'invalidated' and "inventory_repack_boxes"."invalidation_source" is null));
