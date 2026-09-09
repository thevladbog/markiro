ALTER TABLE "national_catalog_product_links" ADD COLUMN "reviewed_projection" jsonb;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD COLUMN "observed_projection" jsonb;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD COLUMN "refresh_checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD COLUMN "refresh_error_code" text;