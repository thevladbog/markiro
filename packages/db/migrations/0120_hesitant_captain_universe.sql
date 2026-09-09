ALTER TABLE "national_catalog_import_images" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "national_catalog_import_images" ADD COLUMN "preparation_actor_id" text;--> statement-breakpoint
ALTER TABLE "national_catalog_import_images" ADD COLUMN "preparation_checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD COLUMN "reviewed_photo" jsonb;--> statement-breakpoint
ALTER TABLE "national_catalog_import_images" ADD CONSTRAINT "national_catalog_import_images_preparation_actor_id_user_id_fk" FOREIGN KEY ("preparation_actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;