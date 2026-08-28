ALTER TABLE "inventory_repack_boxes" DROP CONSTRAINT "inventory_repack_boxes_print_state_check";--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_print_state_check" CHECK (("inventory_repack_boxes"."print_state" = 'failed' and "inventory_repack_boxes"."print_error_code" is not null)
        or "inventory_repack_boxes"."print_state" = 'printed'
        or ("inventory_repack_boxes"."print_state" not in ('failed', 'printed') and "inventory_repack_boxes"."print_error_code" is null));