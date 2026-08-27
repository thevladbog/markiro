CREATE TYPE "public"."inventory_document_run_status" AS ENUM('queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "inventory_document_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"format_id" text NOT NULL,
	"format_version" integer NOT NULL,
	"part_number" integer NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"row_count" integer NOT NULL,
	"code_count" integer NOT NULL,
	"box_count" integer NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"object_key" text NOT NULL,
	"downloaded_at" timestamp with time zone,
	"downloaded_by_user_id" text,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_document_artifacts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_document_artifacts_tenant_run_format_part_uq" UNIQUE("tenant_id","run_id","format_id","part_number"),
	CONSTRAINT "inventory_document_artifacts_format_version_positive_check" CHECK ("inventory_document_artifacts"."format_version" > 0),
	CONSTRAINT "inventory_document_artifacts_part_number_positive_check" CHECK ("inventory_document_artifacts"."part_number" > 0),
	CONSTRAINT "inventory_document_artifacts_row_count_nonnegative_check" CHECK ("inventory_document_artifacts"."row_count" >= 0),
	CONSTRAINT "inventory_document_artifacts_code_count_nonnegative_check" CHECK ("inventory_document_artifacts"."code_count" >= 0),
	CONSTRAINT "inventory_document_artifacts_box_count_nonnegative_check" CHECK ("inventory_document_artifacts"."box_count" >= 0),
	CONSTRAINT "inventory_document_artifacts_byte_size_positive_check" CHECK ("inventory_document_artifacts"."byte_size" > 0),
	CONSTRAINT "inventory_document_artifacts_sha256_check" CHECK ("inventory_document_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_document_artifacts_download_fields_check" CHECK (("inventory_document_artifacts"."downloaded_at" is null and "inventory_document_artifacts"."downloaded_by_user_id" is null)
        or ("inventory_document_artifacts"."downloaded_at" is not null and "inventory_document_artifacts"."downloaded_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_document_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"result_revision" integer NOT NULL,
	"selected_formats" jsonb NOT NULL,
	"request_digest" char(64) NOT NULL,
	"status" "inventory_document_run_status" DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"created_by_user_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"source_snapshot_started_at" timestamp with time zone,
	"source_snapshot_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_document_runs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_document_runs_tenant_actor_idempotency_uq" UNIQUE("tenant_id","created_by_user_id","idempotency_key"),
	CONSTRAINT "inventory_document_runs_result_revision_nonnegative_check" CHECK ("inventory_document_runs"."result_revision" >= 0),
	CONSTRAINT "inventory_document_runs_selected_formats_nonempty_check" CHECK (jsonb_typeof("inventory_document_runs"."selected_formats") = 'array' and jsonb_array_length("inventory_document_runs"."selected_formats") > 0),
	CONSTRAINT "inventory_document_runs_request_digest_check" CHECK ("inventory_document_runs"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_document_runs_attempt_count_nonnegative_check" CHECK ("inventory_document_runs"."attempt_count" >= 0),
	CONSTRAINT "inventory_document_runs_status_consistency_check" CHECK (("inventory_document_runs"."status" = 'ready' and "inventory_document_runs"."completed_at" is not null and "inventory_document_runs"."error_code" is null)
        or ("inventory_document_runs"."status" = 'failed' and "inventory_document_runs"."completed_at" is not null and "inventory_document_runs"."error_code" is not null)
        or ("inventory_document_runs"."status" in ('queued', 'processing') and "inventory_document_runs"."completed_at" is null and "inventory_document_runs"."error_code" is null))
);
--> statement-breakpoint
ALTER TABLE "inventory_document_artifacts" ADD CONSTRAINT "inventory_document_artifacts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_document_artifacts" ADD CONSTRAINT "inventory_document_artifacts_downloaded_by_user_id_user_id_fk" FOREIGN KEY ("downloaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_document_artifacts" ADD CONSTRAINT "inventory_document_artifacts_tenant_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."inventory_document_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD CONSTRAINT "inventory_document_runs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD CONSTRAINT "inventory_document_runs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD CONSTRAINT "inventory_document_runs_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_document_runs_tenant_inventory_created_idx" ON "inventory_document_runs" USING btree ("tenant_id","inventory_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_document_runs_queued_created_idx" ON "inventory_document_runs" USING btree ("created_at") WHERE "inventory_document_runs"."status" = 'queued';