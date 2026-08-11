CREATE TABLE "station_sync_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"terminal_id" uuid NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"record_kind" text NOT NULL,
	"record_index" integer NOT NULL,
	"shift_id" uuid,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_sync_quarantine_record_uq" UNIQUE("tenant_id","batch_id","record_kind","record_index"),
	CONSTRAINT "station_sync_quarantine_digest_check" CHECK ("station_sync_quarantine"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "station_sync_quarantine_record_kind_check" CHECK ("station_sync_quarantine"."record_kind" IN ('item', 'box', 'exception')),
	CONSTRAINT "station_sync_quarantine_record_index_check" CHECK ("station_sync_quarantine"."record_index" >= 0),
	CONSTRAINT "station_sync_quarantine_reason_check" CHECK (char_length("station_sync_quarantine"."reason") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "sync_batches" ADD COLUMN "terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD COLUMN "payload_digest" char(64);--> statement-breakpoint
ALTER TABLE "sync_batches" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" ADD CONSTRAINT "station_sync_quarantine_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" ADD CONSTRAINT "station_sync_quarantine_tenant_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."sync_batches"("tenant_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" ADD CONSTRAINT "station_sync_quarantine_tenant_terminal_fk" FOREIGN KEY ("tenant_id","terminal_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_sync_quarantine_tenant_time_idx" ON "station_sync_quarantine" USING btree ("tenant_id","quarantined_at");--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_tenant_terminal_fk" FOREIGN KEY ("tenant_id","terminal_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_binding_pair_check" CHECK (("sync_batches"."terminal_id" IS NULL) = ("sync_batches"."payload_digest" IS NULL));--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_payload_digest_check" CHECK ("sync_batches"."payload_digest" IS NULL OR "sync_batches"."payload_digest" ~ '^[0-9a-f]{64}$');