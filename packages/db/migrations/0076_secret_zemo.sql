ALTER TYPE "public"."inventory_scan_event_kind" ADD VALUE 'repack_action';--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD COLUMN "opened_event_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD COLUMN "closed_event_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD COLUMN "source_event_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD COLUMN "source_parent_mismatch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" DROP CONSTRAINT "inventory_repack_items_tenant_box_result_uq";--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_tenant_opened_event_fk" FOREIGN KEY ("tenant_id","inventory_id","opened_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_tenant_closed_event_fk" FOREIGN KEY ("tenant_id","inventory_id","closed_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD CONSTRAINT "inventory_repack_items_tenant_source_event_fk" FOREIGN KEY ("tenant_id","inventory_id","source_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_repack_items_active_box_position_uq" ON "inventory_repack_items" USING btree ("tenant_id","inventory_id","box_id","position") WHERE "inventory_repack_items"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_repack_items_tenant_box_result_uq" ON "inventory_repack_items" USING btree ("tenant_id","box_id","result_id") WHERE "inventory_repack_items"."removed_at" is null;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD CONSTRAINT "inventory_repack_items_position_check" CHECK ("inventory_repack_items"."position" is null or "inventory_repack_items"."position" > 0);
