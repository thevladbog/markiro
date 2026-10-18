CREATE TABLE "unit_label_facts" (
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"source_device_id" uuid NOT NULL,
	"fact" jsonb NOT NULL,
	"digest" char(64) NOT NULL,
	CONSTRAINT "unit_label_facts_tenant_id_shift_id_code_hash_accepted_at_pk" PRIMARY KEY("tenant_id","shift_id","code_hash","accepted_at"),
	CONSTRAINT "unit_label_facts_json_check" CHECK (jsonb_typeof("unit_label_facts"."fact")='object'),
	CONSTRAINT "unit_label_facts_digest_check" CHECK ("unit_label_facts"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "unit_label_facts" ADD CONSTRAINT "unit_label_facts_tenant_id_shift_id_shifts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_label_facts" ADD CONSTRAINT "unit_label_facts_tenant_id_source_device_id_station_devices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;