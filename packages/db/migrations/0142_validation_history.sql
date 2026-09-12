CREATE TABLE "validation_history_snapshot_entries" (
	"tenant_id" text NOT NULL,
	"snapshot_id" char(64) NOT NULL,
	"cursor" text NOT NULL,
	"code_hash" char(64) NOT NULL,
	"kind" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"shift_number" text NOT NULL,
	"shift_status" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "validation_history_snapshot_entries_tenant_id_snapshot_id_cursor_pk" PRIMARY KEY("tenant_id","snapshot_id","cursor"),
	CONSTRAINT "validation_history_kind_check" CHECK ("validation_history_snapshot_entries"."kind" IN ('original', 'reprocessing')),
	CONSTRAINT "validation_history_status_check" CHECK ("validation_history_snapshot_entries"."shift_status" IN ('planned', 'active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "validation_history_snapshots" (
	"tenant_id" text NOT NULL,
	"snapshot_id" char(64) NOT NULL,
	"shift_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "validation_history_snapshots_tenant_id_snapshot_id_pk" PRIMARY KEY("tenant_id","snapshot_id")
);
--> statement-breakpoint
ALTER TABLE "validation_history_snapshot_entries" ADD CONSTRAINT "validation_history_entry_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."validation_history_snapshots"("tenant_id","snapshot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_history_snapshots" ADD CONSTRAINT "validation_history_snapshots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_history_snapshots" ADD CONSTRAINT "validation_history_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_history_snapshots" ADD CONSTRAINT "validation_history_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "validation_history_expiry_idx" ON "validation_history_snapshots" USING btree ("tenant_id","expires_at");