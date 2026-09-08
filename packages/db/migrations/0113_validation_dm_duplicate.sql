CREATE TABLE "product_label_event_receipts" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"outcome" text NOT NULL,
	"rejection_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_label_event_receipts_tenant_id_device_id_event_id_pk" PRIMARY KEY("tenant_id","device_id","event_id"),
	CONSTRAINT "product_label_receipts_digest_check" CHECK ("product_label_event_receipts"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "product_label_receipts_outcome_check" CHECK (
    ("product_label_event_receipts"."outcome" = 'accepted' AND "product_label_event_receipts"."rejection_code" IS NULL)
    OR ("product_label_event_receipts"."outcome" = 'quarantined' AND "product_label_event_receipts"."rejection_code" IS NOT NULL AND "product_label_event_receipts"."rejection_code" IN
      ('parent_missing', 'policy_mismatch', 'ownership_conflict', 'invalid_transition', 'sequence_gap', 'subscription_read_only')))
);
--> statement-breakpoint
CREATE TABLE "product_label_events" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"operator_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"receive_status" text NOT NULL,
	"reason_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_label_events_tenant_id_device_id_event_id_pk" PRIMARY KEY("tenant_id","device_id","event_id"),
	CONSTRAINT "product_label_events_job_sequence_uq" UNIQUE("tenant_id","device_id","job_id","sequence"),
	CONSTRAINT "product_label_events_sequence_check" CHECK ("product_label_events"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "product_label_events_digest_check" CHECK ("product_label_events"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "product_label_events_event_check" CHECK (jsonb_typeof("product_label_events"."event") = 'object'),
	CONSTRAINT "product_label_events_receive_status_check" CHECK (
    ("product_label_events"."receive_status" = 'accepted' AND "product_label_events"."reason_code" IS NULL)
    OR ("product_label_events"."receive_status" IN ('conflict', 'rejected') AND "product_label_events"."reason_code" IS NOT NULL AND char_length("product_label_events"."reason_code") BETWEEN 1 AND 64))
);
--> statement-breakpoint
CREATE TABLE "product_label_jobs" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"policy_revision" uuid NOT NULL,
	"template_digest" char(64) NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"latest_sequence" bigint NOT NULL,
	"projection" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_label_jobs_tenant_id_device_id_job_id_pk" PRIMARY KEY("tenant_id","device_id","job_id"),
	CONSTRAINT "product_label_jobs_sequence_check" CHECK ("product_label_jobs"."latest_sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "product_label_jobs_digests_check" CHECK ("product_label_jobs"."code_hash" ~ '^[0-9a-f]{64}$' AND "product_label_jobs"."template_digest" ~ '^[0-9a-f]{64}$' AND "product_label_jobs"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "product_label_jobs_projection_check" CHECK (jsonb_typeof("product_label_jobs"."projection") = 'object')
);
--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" DROP CONSTRAINT "station_sync_quarantine_record_kind_check";--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "validation_print_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "validation_print_verification" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "validation_print_template_id" uuid;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "validation_print_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "validation_print_policy_revision" uuid;--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "purpose" text DEFAULT 'box' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_label_event_receipts" ADD CONSTRAINT "product_label_event_receipts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_event_receipts" ADD CONSTRAINT "product_label_receipts_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_events" ADD CONSTRAINT "product_label_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_events" ADD CONSTRAINT "product_label_events_tenant_job_fk" FOREIGN KEY ("tenant_id","device_id","job_id") REFERENCES "public"."product_label_jobs"("tenant_id","device_id","job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_events" ADD CONSTRAINT "product_label_events_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_jobs" ADD CONSTRAINT "product_label_jobs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_jobs" ADD CONSTRAINT "product_label_jobs_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_label_jobs" ADD CONSTRAINT "product_label_jobs_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_label_jobs_history_idx" ON "product_label_jobs" USING btree ("tenant_id","shift_id","accepted_at","job_id");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_validation_print_template_fk" FOREIGN KEY ("tenant_id","validation_print_template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_validation_print_policy_check" CHECK (
      ("shifts"."validation_print_mode" = 'none'
        AND "shifts"."validation_print_verification" = 'none'
        AND "shifts"."validation_print_template_id" IS NULL
        AND "shifts"."validation_print_snapshot" IS NULL
        AND "shifts"."validation_print_policy_revision" IS NULL)
      OR ("shifts"."mode" = 'validation' AND "shifts"."validation_print_mode" = 'duplicate_dm'
        AND "shifts"."validation_print_verification" IN ('none', 'required')
        AND "shifts"."validation_print_template_id" IS NOT NULL
        AND "shifts"."validation_print_snapshot" IS NOT NULL
        AND "shifts"."validation_print_policy_revision" IS NOT NULL)
    );--> statement-breakpoint
ALTER TABLE "station_sync_quarantine" ADD CONSTRAINT "station_sync_quarantine_record_kind_check" CHECK ("station_sync_quarantine"."record_kind" IN ('item', 'box', 'exception', 'product_label_event'));--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_purpose_check" CHECK ("label_templates"."purpose" IN ('box', 'product_duplicate'));
--> statement-breakpoint
-- A separate purpose prevents a same-name legacy box template from being repurposed.
-- Keep tenant edits and every existing box default; retry must never reset a template.
INSERT INTO "label_templates" ("id", "tenant_id", "name", "spec", "purpose")
SELECT gen_random_uuid(), o.id, 'Дубликат Data Matrix 58×40 (203 dpi)',
'{
  "widthMm": 58,
  "heightMm": 40,
  "dpi": 203,
  "language": "zpl",
  "elements": [
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 3,
      "yMm": 3,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 24
    },
    {
      "id": "caption",
      "kind": "text",
      "xMm": 30,
      "yMm": 4,
      "text": "DATA MATRIX",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 25
    },
    {
      "id": "gtin",
      "kind": "field",
      "xMm": 30,
      "yMm": 10,
      "field": "product.gtin",
      "fontSizePt": 7,
      "maxWidthMm": 25
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 30,
      "yMm": 16,
      "field": "date",
      "fontSizePt": 8,
      "maxWidthMm": 25
    },
    {
      "id": "product",
      "kind": "field",
      "xMm": 3,
      "yMm": 30,
      "field": "product.printName",
      "fontSizePt": 9,
      "maxWidthMm": 52,
      "maxLines": 2
    }
  ]
}'::jsonb, 'product_duplicate'
FROM "organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "label_templates" t
  WHERE t.tenant_id = o.id
    AND t.purpose = 'product_duplicate'
    AND t.name = 'Дубликат Data Matrix 58×40 (203 dpi)'
);
