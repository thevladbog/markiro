CREATE TABLE "pickup_scan_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kiosk_id" uuid NOT NULL,
	"employee_id" uuid,
	"badge_code" text,
	"order_id" uuid,
	"device_seq" integer NOT NULL,
	"codes" jsonb NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_user_id" text,
	CONSTRAINT "pickup_scan_rejections_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pickup_scan_rejections_kiosk_device_seq_uq" UNIQUE("tenant_id","kiosk_id","device_seq"),
	CONSTRAINT "pickup_scan_rejections_badge_xor_employee" CHECK ((employee_id is null) = (badge_code is not null))
);
--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_tenant_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_tenant_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pickup_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_scan_rejections_open_idx" ON "pickup_scan_rejections" USING btree ("tenant_id","synced_at") WHERE acknowledged_at is null;