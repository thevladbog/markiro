CREATE TYPE "public"."inventory_progress_change_kind" AS ENUM('claim', 'correction');--> statement-breakpoint
CREATE TABLE "inventory_progress_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"result_revision" integer NOT NULL,
	"kind" "inventory_progress_change_kind" NOT NULL,
	"code_hash" char(64) NOT NULL,
	"classification" "inventory_code_classification" NOT NULL,
	"observed_production_date" date,
	"winning_event_id" uuid,
	"winning_device_id" uuid,
	"winning_scanned_at" timestamp with time zone,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_progress_changes_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_progress_changes_revision_check" CHECK ("inventory_progress_changes"."result_revision" > 0),
	CONSTRAINT "inventory_progress_changes_hash_check" CHECK ("inventory_progress_changes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_progress_changes_winner_check" CHECK (("inventory_progress_changes"."winning_event_id" is null and "inventory_progress_changes"."winning_device_id" is null and "inventory_progress_changes"."winning_scanned_at" is null)
        or ("inventory_progress_changes"."winning_event_id" is not null and "inventory_progress_changes"."winning_device_id" is not null and "inventory_progress_changes"."winning_scanned_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "inventory_progress_changes" ADD CONSTRAINT "inventory_progress_changes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_progress_changes" ADD CONSTRAINT "inventory_progress_changes_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_progress_changes" ADD CONSTRAINT "inventory_progress_changes_tenant_snapshot_inventory_fk" FOREIGN KEY ("tenant_id","snapshot_id","inventory_id") REFERENCES "public"."inventory_snapshots"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_progress_changes" ADD CONSTRAINT "inventory_progress_changes_tenant_winner_event_fk" FOREIGN KEY ("tenant_id","inventory_id","winning_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_progress_changes" ADD CONSTRAINT "inventory_progress_changes_tenant_winner_device_fk" FOREIGN KEY ("tenant_id","winning_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_progress_changes_cursor_idx" ON "inventory_progress_changes" USING btree ("tenant_id","inventory_id","result_revision","id");