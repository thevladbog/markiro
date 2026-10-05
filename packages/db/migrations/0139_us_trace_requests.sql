CREATE TABLE "trace_export_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trace_export_artifacts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "trace_export_artifacts_kind_uq" UNIQUE("tenant_id","run_id","kind"),
	CONSTRAINT "trace_export_artifacts_filename_uq" UNIQUE("tenant_id","run_id","filename"),
	CONSTRAINT "trace_export_artifacts_kind_valid" CHECK ("trace_export_artifacts"."kind" IN ('xlsx','plan_pdf','validation_report','request_report','manifest','package_zip')),
	CONSTRAINT "trace_export_artifacts_size_positive" CHECK ("trace_export_artifacts"."byte_size" > 0),
	CONSTRAINT "trace_export_artifacts_digest_valid" CHECK ("trace_export_artifacts"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "trace_export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"command_digest" text NOT NULL,
	"scoped_content_digest" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_digest" text,
	"plan_version_id" uuid,
	"plan_pdf_sha256" text,
	"registry_version" integer,
	"registry_hash" text,
	"export_ready" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"generation_started_at" timestamp with time zone,
	"report_rendered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trace_export_runs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "trace_export_runs_revision_uq" UNIQUE("tenant_id","request_id","revision"),
	CONSTRAINT "trace_export_runs_idempotency_uq" UNIQUE("tenant_id","created_by","idempotency_key"),
	CONSTRAINT "trace_export_runs_mode_valid" CHECK ("trace_export_runs"."mode" IN ('export_ready','available_records_incomplete')),
	CONSTRAINT "trace_export_runs_status_valid" CHECK (("trace_export_runs"."status" IN ('queued','processing') AND "trace_export_runs"."completed_at" IS NULL AND "trace_export_runs"."failure_code" IS NULL) OR ("trace_export_runs"."status" = 'ready' AND "trace_export_runs"."completed_at" IS NOT NULL AND "trace_export_runs"."failure_code" IS NULL) OR ("trace_export_runs"."status" = 'failed' AND "trace_export_runs"."completed_at" IS NOT NULL AND "trace_export_runs"."failure_code" IS NOT NULL)),
	CONSTRAINT "trace_export_runs_ready_valid" CHECK (NOT "trace_export_runs"."export_ready" OR ("trace_export_runs"."mode" = 'export_ready' AND "trace_export_runs"."status" = 'ready')),
	CONSTRAINT "trace_export_runs_snapshot_object" CHECK (jsonb_typeof("trace_export_runs"."input_snapshot") = 'object'),
	CONSTRAINT "trace_export_runs_input_binding" CHECK (("trace_export_runs"."input_digest" IS NULL) = COALESCE("trace_export_runs"."input_snapshot"->>'selectionKind' = 'empty', false)),
	CONSTRAINT "trace_export_runs_plan_binding" CHECK (("trace_export_runs"."plan_version_id" IS NULL) = ("trace_export_runs"."plan_pdf_sha256" IS NULL)),
	CONSTRAINT "trace_export_runs_digests_valid" CHECK ("trace_export_runs"."command_digest" ~ '^[a-f0-9]{64}$' AND "trace_export_runs"."scoped_content_digest" ~ '^[a-f0-9]{64}$' AND "trace_export_runs"."input_digest" ~ '^[a-f0-9]{64}$' AND "trace_export_runs"."plan_pdf_sha256" ~ '^[a-f0-9]{64}$' AND "trace_export_runs"."registry_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "trace_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_number" text NOT NULL,
	"requester_name" text NOT NULL,
	"requester_organization" text,
	"requester_contact" text,
	"received_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"alternate_deadline_reason" text,
	"scope" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_validation" jsonb,
	"last_validation_digest" text,
	"last_validated_at" timestamp with time zone,
	"warning_ack_digest" text,
	"warning_ack_reason" text,
	"warning_ack_at" timestamp with time zone,
	"warning_ack_by" text,
	"created_by" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_requests_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "trace_requests_number_uq" UNIQUE("tenant_id","request_number"),
	CONSTRAINT "trace_requests_due_valid" CHECK ("trace_requests"."due_at" > "trace_requests"."received_at"),
	CONSTRAINT "trace_requests_deadline_reason" CHECK (("trace_requests"."due_at" = "trace_requests"."received_at" + interval '24 hours' AND "trace_requests"."alternate_deadline_reason" IS NULL) OR ("trace_requests"."due_at" <> "trace_requests"."received_at" + interval '24 hours' AND "trace_requests"."alternate_deadline_reason" IS NOT NULL AND char_length(btrim("trace_requests"."alternate_deadline_reason")) BETWEEN 3 AND 2000 AND "trace_requests"."alternate_deadline_reason" ~ '[^[:space:]]')),
	CONSTRAINT "trace_requests_scope_object" CHECK (jsonb_typeof("trace_requests"."scope") = 'object'),
	CONSTRAINT "trace_requests_validation_object" CHECK (jsonb_typeof("trace_requests"."last_validation") = 'object'),
	CONSTRAINT "trace_requests_revision_positive" CHECK ("trace_requests"."revision" > 0),
	CONSTRAINT "trace_requests_status_valid" CHECK (("trace_requests"."status" = 'open' AND "trace_requests"."closed_at" IS NULL) OR ("trace_requests"."status" = 'closed' AND "trace_requests"."closed_at" IS NOT NULL)),
	CONSTRAINT "trace_requests_validation_shape" CHECK (("trace_requests"."last_validation" IS NULL AND "trace_requests"."last_validation_digest" IS NULL AND "trace_requests"."last_validated_at" IS NULL) OR ("trace_requests"."last_validation" IS NOT NULL AND "trace_requests"."last_validation_digest" IS NOT NULL AND "trace_requests"."last_validated_at" IS NOT NULL)),
	CONSTRAINT "trace_requests_ack_shape" CHECK (("trace_requests"."warning_ack_digest" IS NULL AND "trace_requests"."warning_ack_reason" IS NULL AND "trace_requests"."warning_ack_at" IS NULL AND "trace_requests"."warning_ack_by" IS NULL) OR ("trace_requests"."warning_ack_digest" IS NOT NULL AND "trace_requests"."warning_ack_reason" IS NOT NULL AND "trace_requests"."warning_ack_at" IS NOT NULL AND "trace_requests"."warning_ack_by" IS NOT NULL)),
	CONSTRAINT "trace_requests_digests_valid" CHECK ("trace_requests"."last_validation_digest" ~ '^[a-f0-9]{64}$' AND "trace_requests"."warning_ack_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "trace_export_artifacts" ADD CONSTRAINT "trace_export_artifacts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_artifacts" ADD CONSTRAINT "trace_export_artifacts_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."trace_export_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD CONSTRAINT "trace_export_runs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD CONSTRAINT "trace_export_runs_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."trace_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD CONSTRAINT "trace_export_runs_plan_fk" FOREIGN KEY ("tenant_id","plan_version_id") REFERENCES "public"."traceability_plan_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_requests" ADD CONSTRAINT "trace_requests_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_export_artifacts_run_idx" ON "trace_export_artifacts" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "trace_export_runs_queue_idx" ON "trace_export_runs" USING btree ("status","started_at","tenant_id");--> statement-breakpoint
CREATE INDEX "trace_requests_due_idx" ON "trace_requests" USING btree ("tenant_id","status","due_at");