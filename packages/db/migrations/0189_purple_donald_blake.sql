CREATE TABLE "pallet_production_deliveries" (
	"tenant_id" text NOT NULL,
	"sscc" char(18) NOT NULL,
	"source_device_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"digest" char(64) NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "pallet_production_deliveries_tenant_id_sscc_sequence_pk" PRIMARY KEY("tenant_id","sscc","sequence"),
	CONSTRAINT "pallet_production_deliveries_sequence_check" CHECK ("pallet_production_deliveries"."sequence" > 0 AND "pallet_production_deliveries"."sequence" <= 9007199254740991),
	CONSTRAINT "pallet_production_deliveries_digest_check" CHECK ("pallet_production_deliveries"."digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "pallet_production_deliveries_value_check" CHECK (jsonb_typeof("pallet_production_deliveries"."value") = 'object')
);
--> statement-breakpoint
ALTER TABLE "pallet_production_deliveries" ADD CONSTRAINT "pallet_production_deliveries_tenant_id_sscc_pallet_label_sources_tenant_id_sscc_fk" FOREIGN KEY ("tenant_id","sscc") REFERENCES "public"."pallet_label_sources"("tenant_id","sscc") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_production_deliveries" ADD CONSTRAINT "pallet_production_deliveries_tenant_id_source_device_id_station_devices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;