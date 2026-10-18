CREATE TABLE "pallet_label_sources" (
	"tenant_id" text NOT NULL,
	"sscc" char(18) NOT NULL,
	"pallet_id" uuid NOT NULL,
	"source_device_id" uuid NOT NULL,
	"revision" char(64) NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "pallet_label_sources_tenant_id_sscc_pk" PRIMARY KEY("tenant_id","sscc"),
	CONSTRAINT "pallet_label_sources_revision_check" CHECK ("pallet_label_sources"."revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "pallet_label_sources_value_check" CHECK (jsonb_typeof("pallet_label_sources"."value")='object')
);
--> statement-breakpoint
CREATE TABLE "pallet_reprint_events" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"digest" char(64) NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "pallet_reprint_events_tenant_id_device_id_event_id_pk" PRIMARY KEY("tenant_id","device_id","event_id"),
	CONSTRAINT "pallet_reprint_events_digest_check" CHECK ("pallet_reprint_events"."digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pallet_label_sources" ADD CONSTRAINT "pallet_label_sources_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_label_sources" ADD CONSTRAINT "pallet_label_sources_tenant_id_pallet_id_pallets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_label_sources" ADD CONSTRAINT "pallet_label_sources_tenant_id_source_device_id_station_devices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_reprint_events" ADD CONSTRAINT "pallet_reprint_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_reprint_events" ADD CONSTRAINT "pallet_reprint_events_tenant_id_device_id_station_devices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;