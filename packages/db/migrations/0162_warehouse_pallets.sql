CREATE TABLE "pallet_membership_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"pallet_id" uuid NOT NULL,
	"box_sscc" char(18) NOT NULL,
	"box_id" uuid,
	"reason" text NOT NULL,
	"winning_pallet_id" uuid,
	"added_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pallet_membership_rejections_tenant_pallet_sscc_uq" UNIQUE("tenant_id","pallet_id","box_sscc"),
	CONSTRAINT "pallet_membership_rejections_reason_check" CHECK ("pallet_membership_rejections"."reason" IN ('already_on_pallet', 'not_found', 'not_closed', 'disassembled', 'pallet_closed', 'product_mismatch'))
);
--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" DROP CONSTRAINT "station_sync_quarantine_record_kind_check";--> statement-breakpoint
ALTER TABLE "pallet_exceptions" ALTER COLUMN "shift_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pallets" ALTER COLUMN "shift_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_exports" ALTER COLUMN "shift_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pallets" ADD COLUMN "kind" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "pallets" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "pallets" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_pickup_policies" ADD COLUMN "can_build_pallets" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_exports" ADD COLUMN "pallet_id" uuid;--> statement-breakpoint
ALTER TABLE "pallet_membership_rejections" ADD CONSTRAINT "pallet_membership_rejections_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_membership_rejections" ADD CONSTRAINT "pallet_membership_rejections_tenant_pallet_fk" FOREIGN KEY ("tenant_id","pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_membership_rejections" ADD CONSTRAINT "pallet_membership_rejections_tenant_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_membership_rejections" ADD CONSTRAINT "pallet_membership_rejections_tenant_winning_pallet_fk" FOREIGN KEY ("tenant_id","winning_pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_exports" ADD CONSTRAINT "shift_exports_tenant_pallet_fk" FOREIGN KEY ("tenant_id","pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pallets_warehouse_device_pallet_uq" ON "pallets" USING btree ("tenant_id","device_id","device_pallet_id") WHERE "pallets"."kind" = 'warehouse';--> statement-breakpoint
CREATE INDEX "pallets_tenant_kind_closed_idx" ON "pallets" USING btree ("tenant_id","kind","closed_at");--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_kind_check" CHECK ("pallets"."kind" IN ('production', 'warehouse'));--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_kind_shape" CHECK (("pallets"."kind" = 'production' AND "pallets"."shift_id" IS NOT NULL) OR ("pallets"."kind" = 'warehouse' AND "pallets"."shift_id" IS NULL AND "pallets"."product_id" IS NOT NULL AND "pallets"."device_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_warehouse_terminal_check" CHECK ("pallets"."kind" <> 'warehouse' OR ("pallets"."terminal_id" IS NOT NULL AND "pallets"."terminal_id" = "pallets"."device_id"::text));--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" ADD CONSTRAINT "station_sync_quarantine_record_kind_check" CHECK ("station_sync_quarantine"."record_kind" IN ('item', 'box', 'exception', 'product_label_event', 'pallet', 'pallet_exception', 'pallet_membership'));--> statement-breakpoint
ALTER TABLE "shift_exports" ADD CONSTRAINT "shift_exports_target_shape" CHECK (("shift_exports"."shift_id" IS NOT NULL AND "shift_exports"."pallet_id" IS NULL) OR ("shift_exports"."shift_id" IS NULL AND "shift_exports"."pallet_id" IS NOT NULL));