CREATE TYPE "public"."station_close_policy" AS ENUM('single_device', 'admin_only');--> statement-breakpoint
CREATE TYPE "public"."station_shift_close_outcome" AS ENUM('accepted', 'conflict', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TABLE "shift_device_participants" (
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"first_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_device_participants_tenant_shift_device_uq" UNIQUE("tenant_id","shift_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "station_shift_close_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"operator_id" uuid,
	"payload_digest" char(64) NOT NULL,
	"planned_qty_snapshot" integer,
	"actual_qty" integer NOT NULL,
	"closed_box_count" integer NOT NULL,
	"reason_code" text,
	"closed_at" timestamp with time zone NOT NULL,
	"outcome" "station_shift_close_outcome" DEFAULT 'accepted' NOT NULL,
	"conflict_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "station_shift_close_events_payload_uq" UNIQUE("tenant_id","event_id","payload_digest"),
	CONSTRAINT "station_shift_close_events_digest_check" CHECK ("station_shift_close_events"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "station_shift_close_events_counts_check" CHECK ("station_shift_close_events"."actual_qty" >= 0 AND "station_shift_close_events"."closed_box_count" >= 0),
	CONSTRAINT "station_shift_close_events_reason_check" CHECK ("station_shift_close_events"."reason_code" IS NULL OR "station_shift_close_events"."reason_code" IN ('production_defect', 'material_shortage', 'equipment_stop', 'production_order_changed', 'planned_quantity_error', 'other_production_deviation'))
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "station_close_policy" "station_close_policy" DEFAULT 'single_device' NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "station_close_owner_device_id" uuid;--> statement-breakpoint
ALTER TABLE "shift_device_participants" ADD CONSTRAINT "shift_device_participants_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_device_participants" ADD CONSTRAINT "shift_device_participants_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_device_participants" ADD CONSTRAINT "shift_device_participants_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_shift_close_events" ADD CONSTRAINT "station_shift_close_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_shift_close_events" ADD CONSTRAINT "station_shift_close_events_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_shift_close_events" ADD CONSTRAINT "station_shift_close_events_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_device_participants_tenant_shift_idx" ON "shift_device_participants" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE INDEX "station_shift_close_events_tenant_outcome_idx" ON "station_shift_close_events" USING btree ("tenant_id","outcome","recorded_at");
