ALTER TABLE "inventory_snapshot_codes" DROP CONSTRAINT "inventory_snapshot_codes_classification_check";--> statement-breakpoint
ALTER TABLE "inventory_snapshot_codes" ADD CONSTRAINT "inventory_snapshot_codes_classification_check" CHECK (not ("inventory_snapshot_codes"."expected" and "inventory_snapshot_codes"."protected")
        and "inventory_snapshot_codes"."protected" = coalesce("inventory_snapshot_codes"."source_state" = 'MOVING_BY_UD', false)
        and ("inventory_snapshot_codes"."protected"
          or "inventory_snapshot_codes"."source_status" <> 'INTRODUCED'
          or "inventory_snapshot_codes"."source_production_date" is not null)
        and (not "inventory_snapshot_codes"."expected"
          or ("inventory_snapshot_codes"."source_status" = 'INTRODUCED' and "inventory_snapshot_codes"."source_production_date" is not null)));