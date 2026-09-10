CREATE TYPE "public"."platform_report_status" AS ENUM('queued', 'processing', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "platform_report_tenants" (
	"report_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "platform_report_tenants_report_id_tenant_id_pk" PRIMARY KEY("report_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "platform_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"status" "platform_report_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"artifact_object_key" text,
	"artifact_checksum" text,
	"artifact_byte_size" bigint,
	"artifact_filename" text,
	"snapshot_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"row_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_reports_creator_idempotency_uq" UNIQUE("created_by_platform_user_id","idempotency_key"),
	CONSTRAINT "platform_reports_attempt_count_nonnegative" CHECK ("platform_reports"."attempt_count" >= 0),
	CONSTRAINT "platform_reports_artifact_consistency" CHECK (("platform_reports"."status" = 'ready' and "platform_reports"."artifact_object_key" is not null and "platform_reports"."artifact_checksum" is not null and "platform_reports"."artifact_byte_size" is not null and "platform_reports"."artifact_filename" is not null) or ("platform_reports"."status" <> 'ready' and "platform_reports"."artifact_object_key" is null and "platform_reports"."artifact_checksum" is null and "platform_reports"."artifact_byte_size" is null and "platform_reports"."artifact_filename" is null)),
	CONSTRAINT "platform_reports_completion_consistency" CHECK (("platform_reports"."status" in ('ready', 'failed', 'expired') and "platform_reports"."completed_at" is not null) or ("platform_reports"."status" in ('queued', 'processing') and "platform_reports"."completed_at" is null)),
	CONSTRAINT "platform_reports_checksum_format" CHECK ("platform_reports"."artifact_checksum" is null or "platform_reports"."artifact_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_reports_counts_nonnegative" CHECK (("platform_reports"."row_count" is null or "platform_reports"."row_count" >= 0) and ("platform_reports"."artifact_byte_size" is null or "platform_reports"."artifact_byte_size" >= 0)),
	CONSTRAINT "platform_reports_error_consistency" CHECK (("platform_reports"."status" = 'failed' and "platform_reports"."error_code" is not null) or ("platform_reports"."status" <> 'failed' and "platform_reports"."error_code" is null)),
	CONSTRAINT "platform_reports_error_code_vocabulary" CHECK ("platform_reports"."error_code" is null or "platform_reports"."error_code" in ('REPORT_LIMIT_EXCEEDED', 'REPORT_INVALID_PARAMETERS', 'REPORT_PERMISSION_REVOKED', 'REPORT_SOURCE_FAILED', 'REPORT_SOURCE_TIMEOUT', 'REPORT_STORAGE_FAILED', 'REPORT_RETRY_EXHAUSTED', 'REPORT_GENERATION_FAILED')),
	CONSTRAINT "platform_reports_lease_consistency" CHECK (("platform_reports"."status" = 'processing') = ("platform_reports"."lease_expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "platform_report_tenants" ADD CONSTRAINT "platform_report_tenants_report_id_platform_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."platform_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_report_tenants" ADD CONSTRAINT "platform_report_tenants_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_reports" ADD CONSTRAINT "platform_reports_creator_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_reports_creator_created_idx" ON "platform_reports" USING btree ("created_by_platform_user_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_reports_queued_created_idx" ON "platform_reports" USING btree ("created_at") WHERE "platform_reports"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "platform_reports_expiry_idx" ON "platform_reports" USING btree ("expires_at");
