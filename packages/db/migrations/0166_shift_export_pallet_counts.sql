ALTER TABLE "shift_export_artifacts" ADD COLUMN "pallet_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_exports" ADD COLUMN "total_pallet_count" integer;--> statement-breakpoint
ALTER TABLE "shift_export_artifacts" ADD CONSTRAINT "shift_export_artifacts_pallet_count_nonnegative" CHECK ("shift_export_artifacts"."pallet_count" >= 0);--> statement-breakpoint
ALTER TABLE "shift_exports" ADD CONSTRAINT "shift_exports_total_pallet_count_nonnegative" CHECK ("shift_exports"."total_pallet_count" is null or "shift_exports"."total_pallet_count" >= 0);