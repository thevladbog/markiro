CREATE TYPE "public"."inventory_chz_status" AS ENUM('EMITTED', 'INTRODUCED', 'APPLIED', 'RETIRED', 'WRITTEN_OFF', 'DISAGGREGATION');--> statement-breakpoint
CREATE TYPE "public"."inventory_import_container_kind" AS ENUM('csv', 'zip', 'xlsx');--> statement-breakpoint
CREATE TYPE "public"."inventory_import_parse_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inventory_lifecycle_status" AS ENUM('draft', 'preparing', 'ready', 'running', 'closed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."inventory_mode" AS ENUM('check', 'repack');--> statement-breakpoint
CREATE TABLE "inventories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"number" text NOT NULL,
	"product_id" uuid NOT NULL,
	"gtin14_snapshot" char(14) NOT NULL,
	"line_id" uuid NOT NULL,
	"mode" "inventory_mode" NOT NULL,
	"production_date_from" date NOT NULL,
	"production_date_to" date NOT NULL,
	"box_label_template_id" uuid,
	"status" "inventory_lifecycle_status" DEFAULT 'draft' NOT NULL,
	"active_snapshot_id" uuid,
	"result_revision" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"started_by_user_id" text,
	"started_at" timestamp with time zone,
	"closed_by_user_id" text,
	"closed_at" timestamp with time zone,
	"emergency_close_reason" text,
	"emergency_closed_by_user_id" text,
	"emergency_closed_at" timestamp with time zone,
	"completion_acknowledged_by_user_id" text,
	"completion_acknowledged_at" timestamp with time zone,
	"completed_by_user_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventories_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventories_tenant_number_uq" UNIQUE("tenant_id","number"),
	CONSTRAINT "inventories_production_date_order_check" CHECK ("inventories"."production_date_from" <= "inventories"."production_date_to"),
	CONSTRAINT "inventories_gtin14_snapshot_check" CHECK ("inventories"."gtin14_snapshot" ~ '^[0-9]{14}$'),
	CONSTRAINT "inventories_number_nonempty_check" CHECK (length(btrim("inventories"."number")) > 0),
	CONSTRAINT "inventories_result_revision_nonnegative_check" CHECK ("inventories"."result_revision" >= 0),
	CONSTRAINT "inventories_mode_template_check" CHECK (("inventories"."mode" = 'check' and "inventories"."box_label_template_id" is null)
        or ("inventories"."mode" = 'repack' and "inventories"."box_label_template_id" is not null)),
	CONSTRAINT "inventories_active_snapshot_lifecycle_check" CHECK (("inventories"."status" in ('draft', 'preparing') and "inventories"."active_snapshot_id" is null)
        or ("inventories"."status" in ('ready', 'running', 'closed', 'completed') and "inventories"."active_snapshot_id" is not null)),
	CONSTRAINT "inventories_emergency_close_fields_check" CHECK (("inventories"."emergency_close_reason" is null and "inventories"."emergency_closed_by_user_id" is null and "inventories"."emergency_closed_at" is null)
        or ("inventories"."emergency_close_reason" is not null and "inventories"."emergency_closed_by_user_id" is not null and "inventories"."emergency_closed_at" is not null)),
	CONSTRAINT "inventories_completion_acknowledgement_fields_check" CHECK (("inventories"."completion_acknowledged_by_user_id" is null and "inventories"."completion_acknowledged_at" is null)
        or ("inventories"."completion_acknowledged_by_user_id" is not null and "inventories"."completion_acknowledged_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"declared_status" "inventory_chz_status" NOT NULL,
	"file_name" text NOT NULL,
	"container_kind" "inventory_import_container_kind" NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"object_key" text NOT NULL,
	"parsed_status" "inventory_chz_status",
	"included_gtin14" char(14),
	"parse_outcome" "inventory_import_parse_outcome" NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_imports_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_imports_tenant_id_inventory_status_uq" UNIQUE("tenant_id","id","inventory_id","declared_status"),
	CONSTRAINT "inventory_imports_byte_size_nonnegative_check" CHECK ("inventory_imports"."byte_size" >= 0),
	CONSTRAINT "inventory_imports_sha256_check" CHECK ("inventory_imports"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_imports_included_gtin14_check" CHECK ("inventory_imports"."included_gtin14" is null or "inventory_imports"."included_gtin14" ~ '^[0-9]{14}$'),
	CONSTRAINT "inventory_imports_counts_nonnegative_check" CHECK ("inventory_imports"."row_count" >= 0 and "inventory_imports"."error_count" >= 0 and "inventory_imports"."duplicate_count" >= 0),
	CONSTRAINT "inventory_imports_error_code_check" CHECK ("inventory_imports"."error_code" is null or "inventory_imports"."error_code" ~ '^[A-Z][A-Z0-9_]{0,127}$'),
	CONSTRAINT "inventory_imports_parse_outcome_check" CHECK (("inventory_imports"."parse_outcome" = 'succeeded'
          and "inventory_imports"."parsed_status" = "inventory_imports"."declared_status"
          and "inventory_imports"."included_gtin14" is not null
          and "inventory_imports"."error_code" is null)
        or ("inventory_imports"."parse_outcome" = 'failed' and "inventory_imports"."error_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshot_codes" (
	"tenant_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"canonical_raw" text NOT NULL,
	"code_hash" char(64) NOT NULL,
	"gtin14" char(14) NOT NULL,
	"serial" text NOT NULL,
	"source_status" "inventory_chz_status" NOT NULL,
	"source_state" text,
	"source_production_date" date,
	"parent_sscc" char(18),
	"expected" boolean NOT NULL,
	"protected" boolean NOT NULL,
	CONSTRAINT "inventory_snapshot_codes_tenant_hash_uq" UNIQUE("tenant_id","snapshot_id","code_hash"),
	CONSTRAINT "inventory_snapshot_codes_hash_check" CHECK ("inventory_snapshot_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_snapshot_codes_gtin14_check" CHECK ("inventory_snapshot_codes"."gtin14" ~ '^[0-9]{14}$'),
	CONSTRAINT "inventory_snapshot_codes_canonical_raw_size_check" CHECK (octet_length("inventory_snapshot_codes"."canonical_raw") between 1 and 1024),
	CONSTRAINT "inventory_snapshot_codes_serial_nonempty_check" CHECK (length("inventory_snapshot_codes"."serial") > 0),
	CONSTRAINT "inventory_snapshot_codes_parent_sscc_check" CHECK ("inventory_snapshot_codes"."parent_sscc" is null or "inventory_snapshot_codes"."parent_sscc" ~ '^[0-9]{18}$'),
	CONSTRAINT "inventory_snapshot_codes_classification_check" CHECK (not ("inventory_snapshot_codes"."expected" and "inventory_snapshot_codes"."protected")
        and "inventory_snapshot_codes"."protected" = coalesce("inventory_snapshot_codes"."source_state" = 'MOVING_BY_UD', false)
        and (not "inventory_snapshot_codes"."expected"
          or ("inventory_snapshot_codes"."source_status" = 'INTRODUCED' and "inventory_snapshot_codes"."source_production_date" is not null)))
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshot_inputs" (
	"tenant_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"inventory_id" uuid NOT NULL,
	"status" "inventory_chz_status" NOT NULL,
	"import_id" uuid NOT NULL,
	CONSTRAINT "inventory_snapshot_inputs_tenant_snapshot_status_uq" UNIQUE("tenant_id","snapshot_id","status"),
	CONSTRAINT "inventory_snapshot_inputs_tenant_snapshot_import_uq" UNIQUE("tenant_id","snapshot_id","import_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"combined_digest" char(64) NOT NULL,
	"emitted_count" integer NOT NULL,
	"introduced_count" integer NOT NULL,
	"applied_count" integer NOT NULL,
	"retired_count" integer NOT NULL,
	"written_off_count" integer NOT NULL,
	"disaggregation_count" integer NOT NULL,
	"protected_count" integer NOT NULL,
	"expected_count" integer NOT NULL,
	"package_count" integer NOT NULL,
	"loose_count" integer NOT NULL,
	"fixed_by_user_id" text NOT NULL,
	"fixed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_snapshots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_snapshots_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_snapshots_tenant_inventory_uq" UNIQUE("tenant_id","inventory_id"),
	CONSTRAINT "inventory_snapshots_revision_positive_check" CHECK ("inventory_snapshots"."revision" > 0),
	CONSTRAINT "inventory_snapshots_combined_digest_check" CHECK ("inventory_snapshots"."combined_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_snapshots_counts_nonnegative_check" CHECK ("inventory_snapshots"."emitted_count" >= 0
        and "inventory_snapshots"."introduced_count" >= 0
        and "inventory_snapshots"."applied_count" >= 0
        and "inventory_snapshots"."retired_count" >= 0
        and "inventory_snapshots"."written_off_count" >= 0
        and "inventory_snapshots"."disaggregation_count" >= 0
        and "inventory_snapshots"."protected_count" >= 0
        and "inventory_snapshots"."expected_count" >= 0
        and "inventory_snapshots"."package_count" >= 0
        and "inventory_snapshots"."loose_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_emergency_closed_by_user_id_user_id_fk" FOREIGN KEY ("emergency_closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_completion_acknowledged_by_user_id_user_id_fk" FOREIGN KEY ("completion_acknowledged_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_completed_by_user_id_user_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_tenant_line_fk" FOREIGN KEY ("tenant_id","line_id") REFERENCES "public"."lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_tenant_box_label_template_fk" FOREIGN KEY ("tenant_id","box_label_template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_tenant_active_snapshot_fk" FOREIGN KEY ("tenant_id","active_snapshot_id","id") REFERENCES "public"."inventory_snapshots"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_codes" ADD CONSTRAINT "inventory_snapshot_codes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_codes" ADD CONSTRAINT "inventory_snapshot_codes_tenant_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."inventory_snapshots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" ADD CONSTRAINT "inventory_snapshot_inputs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" ADD CONSTRAINT "inventory_snapshot_inputs_tenant_snapshot_inventory_fk" FOREIGN KEY ("tenant_id","snapshot_id","inventory_id") REFERENCES "public"."inventory_snapshots"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_inputs" ADD CONSTRAINT "inventory_snapshot_inputs_tenant_import_inventory_status_fk" FOREIGN KEY ("tenant_id","import_id","inventory_id","status") REFERENCES "public"."inventory_imports"("tenant_id","id","inventory_id","declared_status") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_fixed_by_user_id_user_id_fk" FOREIGN KEY ("fixed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventories_tenant_status_dates_idx" ON "inventories" USING btree ("tenant_id","status","production_date_from","production_date_to");--> statement-breakpoint
CREATE INDEX "inventory_imports_inventory_status_created_idx" ON "inventory_imports" USING btree ("tenant_id","inventory_id","declared_status","created_at");--> statement-breakpoint
CREATE INDEX "inventory_snapshot_codes_parent_sscc_idx" ON "inventory_snapshot_codes" USING btree ("snapshot_id","parent_sscc");--> statement-breakpoint
CREATE INDEX "inventory_snapshot_codes_expected_date_idx" ON "inventory_snapshot_codes" USING btree ("snapshot_id","expected","source_production_date");