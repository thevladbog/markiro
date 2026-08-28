ALTER TABLE "inventory_imports" DROP CONSTRAINT "inventory_imports_parse_outcome_check";--> statement-breakpoint
ALTER TABLE "inventory_snapshot_codes" DROP CONSTRAINT "inventory_snapshot_codes_classification_check";--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" DROP CONSTRAINT "inventory_snapshot_inputs_tenant_import_inventory_status_fk";
--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" ADD COLUMN "import_parse_outcome" "inventory_import_parse_outcome" DEFAULT 'succeeded' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_tenant_id_inventory_status_outcome_uq" UNIQUE("tenant_id","id","inventory_id","declared_status","parse_outcome");--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" ADD CONSTRAINT "inventory_snapshot_inputs_tenant_import_inventory_status_fk" FOREIGN KEY ("tenant_id","import_id","inventory_id","status","import_parse_outcome") REFERENCES "public"."inventory_imports"("tenant_id","id","inventory_id","declared_status","parse_outcome") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_started_fields_check" CHECK (("inventories"."started_by_user_id" is null and "inventories"."started_at" is null)
          or ("inventories"."started_by_user_id" is not null and "inventories"."started_at" is not null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_closed_fields_check" CHECK (("inventories"."closed_by_user_id" is null and "inventories"."closed_at" is null)
          or ("inventories"."closed_by_user_id" is not null and "inventories"."closed_at" is not null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_completed_fields_check" CHECK (("inventories"."completed_by_user_id" is null and "inventories"."completed_at" is null)
          or ("inventories"."completed_by_user_id" is not null and "inventories"."completed_at" is not null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_completed_lifecycle_check" CHECK (("inventories"."status" = 'completed'
            and "inventories"."completed_by_user_id" is not null
            and "inventories"."completed_at" is not null
            and "inventories"."completion_acknowledged_by_user_id" is not null
            and "inventories"."completion_acknowledged_at" is not null)
          or ("inventories"."status" <> 'completed'
            and "inventories"."completed_by_user_id" is null
            and "inventories"."completed_at" is null
            and "inventories"."completion_acknowledged_by_user_id" is null
            and "inventories"."completion_acknowledged_at" is null));--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_parse_outcome_check" CHECK (("inventory_imports"."parse_outcome" = 'succeeded'
          and "inventory_imports"."parsed_status" is not null
          and "inventory_imports"."parsed_status" = "inventory_imports"."declared_status"
          and "inventory_imports"."included_gtin14" is not null
          and "inventory_imports"."error_count" = 0
          and "inventory_imports"."error_code" is null)
        or ("inventory_imports"."parse_outcome" = 'failed'
          and "inventory_imports"."error_count" > 0
          and "inventory_imports"."error_code" is not null));--> statement-breakpoint
ALTER TABLE "inventory_snapshot_codes" ADD CONSTRAINT "inventory_snapshot_codes_classification_check" CHECK (not ("inventory_snapshot_codes"."expected" and "inventory_snapshot_codes"."protected")
        and "inventory_snapshot_codes"."protected" = coalesce("inventory_snapshot_codes"."source_state" = 'MOVING_BY_UD', false)
        and ("inventory_snapshot_codes"."source_status" <> 'INTRODUCED' or "inventory_snapshot_codes"."source_production_date" is not null)
        and (not "inventory_snapshot_codes"."expected"
          or ("inventory_snapshot_codes"."source_status" = 'INTRODUCED' and "inventory_snapshot_codes"."source_production_date" is not null)));--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" ADD CONSTRAINT "inventory_snapshot_inputs_successful_import_check" CHECK ("inventory_snapshot_inputs"."import_parse_outcome" = 'succeeded');
