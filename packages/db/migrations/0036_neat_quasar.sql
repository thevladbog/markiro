CREATE TYPE "public"."shift_export_status" AS ENUM('queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "shift_export_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"export_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"physical_line_count" integer NOT NULL,
	"code_count" integer NOT NULL,
	"box_count" integer NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_export_artifacts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_export_artifacts_tenant_export_part_uq" UNIQUE("tenant_id","export_id","part_number"),
	CONSTRAINT "shift_export_artifacts_part_number_positive" CHECK ("shift_export_artifacts"."part_number" > 0),
	CONSTRAINT "shift_export_artifacts_physical_line_count_positive" CHECK ("shift_export_artifacts"."physical_line_count" > 0),
	CONSTRAINT "shift_export_artifacts_code_count_positive" CHECK ("shift_export_artifacts"."code_count" > 0),
	CONSTRAINT "shift_export_artifacts_box_count_nonnegative" CHECK ("shift_export_artifacts"."box_count" >= 0),
	CONSTRAINT "shift_export_artifacts_byte_size_positive" CHECK ("shift_export_artifacts"."byte_size" > 0),
	CONSTRAINT "shift_export_artifacts_sha256_check" CHECK ("shift_export_artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "shift_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"format_id" text NOT NULL,
	"format_version" integer NOT NULL,
	"max_lines" integer,
	"status" "shift_export_status" DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"product_name_snapshot" text,
	"shift_date_snapshot" date,
	"total_code_count" integer,
	"total_box_count" integer,
	"created_by_user_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"source_snapshot_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_exports_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_exports_tenant_idempotency_uq" UNIQUE("tenant_id","created_by_user_id","idempotency_key"),
	CONSTRAINT "shift_exports_format_version_positive" CHECK ("shift_exports"."format_version" > 0),
	CONSTRAINT "shift_exports_max_lines_range" CHECK ("shift_exports"."max_lines" is null or "shift_exports"."max_lines" between 2 and 1000000),
	CONSTRAINT "shift_exports_total_code_count_positive" CHECK ("shift_exports"."total_code_count" is null or "shift_exports"."total_code_count" > 0),
	CONSTRAINT "shift_exports_total_box_count_nonnegative" CHECK ("shift_exports"."total_box_count" is null or "shift_exports"."total_box_count" >= 0),
	CONSTRAINT "shift_exports_attempt_count_nonnegative" CHECK ("shift_exports"."attempt_count" >= 0),
	CONSTRAINT "shift_exports_status_consistency" CHECK (("shift_exports"."status" = 'ready' and "shift_exports"."completed_at" is not null and "shift_exports"."error_code" is null)
        or ("shift_exports"."status" = 'failed' and "shift_exports"."completed_at" is not null and "shift_exports"."error_code" is not null)
        or ("shift_exports"."status" in ('queued', 'processing') and "shift_exports"."completed_at" is null and "shift_exports"."error_code" is null))
);
--> statement-breakpoint
ALTER TABLE "shift_export_artifacts" ADD CONSTRAINT "shift_export_artifacts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_export_artifacts" ADD CONSTRAINT "shift_export_artifacts_tenant_export_fk" FOREIGN KEY ("tenant_id","export_id") REFERENCES "public"."shift_exports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_exports" ADD CONSTRAINT "shift_exports_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_exports" ADD CONSTRAINT "shift_exports_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_exports" ADD CONSTRAINT "shift_exports_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_exports_tenant_shift_created_idx" ON "shift_exports" USING btree ("tenant_id","shift_id","created_at");--> statement-breakpoint
CREATE INDEX "shift_exports_queued_created_idx" ON "shift_exports" USING btree ("created_at") WHERE "shift_exports"."status" = 'queued';