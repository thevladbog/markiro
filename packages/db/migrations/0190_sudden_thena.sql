CREATE TABLE "pallet_reprint_renderings" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sscc" char(18) NOT NULL,
	"source_revision" char(64) NOT NULL,
	"rendering_revision" char(64) NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "pallet_reprint_renderings_tenant_id_device_id_job_id_pk" PRIMARY KEY("tenant_id","device_id","job_id"),
	CONSTRAINT "pallet_reprint_renderings_digests_check" CHECK ("pallet_reprint_renderings"."source_revision" ~ '^[a-f0-9]{64}$' AND "pallet_reprint_renderings"."rendering_revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "pallet_reprint_renderings_value_check" CHECK (jsonb_typeof("pallet_reprint_renderings"."value")='object' AND octet_length("pallet_reprint_renderings"."value"::text)<1000000)
);
--> statement-breakpoint
CREATE TABLE "pallet_production_resolutions" (
	"tenant_id" text NOT NULL,
	"source_device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sscc" char(18) NOT NULL,
	"source_revision" char(64) NOT NULL,
	"attempt_id" text NOT NULL,
	"digest" char(64) NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "pallet_production_resolutions_tenant_id_source_device_id_event_id_pk" PRIMARY KEY("tenant_id","source_device_id","event_id"),
	CONSTRAINT "pallet_production_resolutions_digest_check" CHECK ("pallet_production_resolutions"."digest" ~ '^[a-f0-9]{64}$' AND "pallet_production_resolutions"."source_revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "pallet_production_resolutions_value_check" CHECK (jsonb_typeof("pallet_production_resolutions"."value")='object' AND octet_length("pallet_production_resolutions"."value"::text)<8192)
);
--> statement-breakpoint
ALTER TABLE "pallet_reprint_renderings" ADD CONSTRAINT "pallet_reprint_renderings_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_reprint_renderings" ADD CONSTRAINT "pallet_reprint_renderings_tenant_id_device_id_station_devices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_reprint_renderings" ADD CONSTRAINT "pallet_reprint_renderings_tenant_id_sscc_pallet_label_sources_tenant_id_sscc_fk" FOREIGN KEY ("tenant_id","sscc") REFERENCES "public"."pallet_label_sources"("tenant_id","sscc") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_production_resolutions" ADD CONSTRAINT "pallet_production_resolutions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_production_resolutions" ADD CONSTRAINT "pallet_production_resolutions_tenant_id_source_device_id_station_devices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_production_resolutions" ADD CONSTRAINT "pallet_production_resolutions_tenant_id_sscc_pallet_label_sources_tenant_id_sscc_fk" FOREIGN KEY ("tenant_id","sscc") REFERENCES "public"."pallet_label_sources"("tenant_id","sscc") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pallet_reprint_renderings_source_idx" ON "pallet_reprint_renderings" USING btree ("tenant_id","sscc");--> statement-breakpoint
CREATE UNIQUE INDEX "pallet_production_resolution_attempt_idx" ON "pallet_production_resolutions" USING btree ("tenant_id","source_device_id","sscc","source_revision","attempt_id");