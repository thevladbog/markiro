CREATE TABLE "warehouse_reprint_events" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"operator_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_reprint_events_tenant_id_device_id_event_id_pk" PRIMARY KEY("tenant_id","device_id","event_id"),
	CONSTRAINT "warehouse_reprint_events_job_sequence_uq" UNIQUE("tenant_id","device_id","job_id","sequence"),
	CONSTRAINT "warehouse_reprint_events_sequence_check" CHECK ("warehouse_reprint_events"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "warehouse_reprint_events_digest_check" CHECK ("warehouse_reprint_events"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "warehouse_reprint_events_json_check" CHECK (jsonb_typeof("warehouse_reprint_events"."event")='object')
);
--> statement-breakpoint
CREATE TABLE "warehouse_reprint_jobs" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"prepared" jsonb NOT NULL,
	"projection" jsonb NOT NULL,
	"latest_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_reprint_jobs_tenant_id_device_id_job_id_pk" PRIMARY KEY("tenant_id","device_id","job_id"),
	CONSTRAINT "warehouse_reprint_jobs_sequence_check" CHECK ("warehouse_reprint_jobs"."latest_sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "warehouse_reprint_jobs_json_check" CHECK (jsonb_typeof("warehouse_reprint_jobs"."prepared")='object' AND jsonb_typeof("warehouse_reprint_jobs"."projection")='object')
);
--> statement-breakpoint
CREATE TABLE "warehouse_reprint_receipts" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"payload_digest" text NOT NULL,
	"rejection_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_reprint_receipts_tenant_id_device_id_event_id_pk" PRIMARY KEY("tenant_id","device_id","event_id"),
	CONSTRAINT "warehouse_reprint_receipts_digest_check" CHECK ("warehouse_reprint_receipts"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "warehouse_reprint_receipts_rejection_check" CHECK ("warehouse_reprint_receipts"."rejection_code" IS NULL OR "warehouse_reprint_receipts"."rejection_code" IN ('parent_missing','source_not_printable','ownership_conflict','invalid_transition','sequence_gap','invalid_operator','template_mismatch'))
);
--> statement-breakpoint
ALTER TABLE "warehouse_reprint_events" ADD CONSTRAINT "warehouse_reprint_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_reprint_events" ADD CONSTRAINT "warehouse_reprint_events_tenant_job_fk" FOREIGN KEY ("tenant_id","device_id","job_id") REFERENCES "public"."warehouse_reprint_jobs"("tenant_id","device_id","job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_reprint_events" ADD CONSTRAINT "warehouse_reprint_events_tenant_actor_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_reprint_jobs" ADD CONSTRAINT "warehouse_reprint_jobs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_reprint_jobs" ADD CONSTRAINT "warehouse_reprint_jobs_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_reprint_receipts" ADD CONSTRAINT "warehouse_reprint_receipts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_reprint_receipts" ADD CONSTRAINT "warehouse_reprint_receipts_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warehouse_reprint_jobs_history_idx" ON "warehouse_reprint_jobs" USING btree ("tenant_id","device_id","created_at","job_id");