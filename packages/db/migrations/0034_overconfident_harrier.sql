CREATE TYPE "public"."billing_profile_kind" AS ENUM('individual', 'self_employed', 'sole_proprietor', 'legal_entity');--> statement-breakpoint
CREATE TYPE "public"."billing_document_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_activation_policy" AS ENUM('immediate', 'after_current', 'manual');--> statement-breakpoint
CREATE TYPE "public"."invoice_application_mode" AS ENUM('manual', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."invoice_application_status" AS ENUM('pending', 'applied', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_kind" AS ENUM('plan', 'addon', 'service', 'custom');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_import_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_match_status" AS ENUM('unmatched', 'suggested', 'matched', 'rejected', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."billing_payment_source" AS ENUM('manual', 'bank_import');--> statement-breakpoint
CREATE TABLE "billing_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"source" "billing_payment_source" NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"bank_reference" text NOT NULL,
	"import_row_id" uuid,
	"platform_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_payments_invoice_uq" UNIQUE("tenant_id","invoice_id"),
	CONSTRAINT "billing_payments_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_payments_amount_positive" CHECK ("billing_payments"."amount" > 0),
	CONSTRAINT "billing_payments_currency_rub_check" CHECK ("billing_payments"."currency" = 'RUB'),
	CONSTRAINT "billing_payments_source_row_check" CHECK (("billing_payments"."source" = 'manual' and "billing_payments"."import_row_id" is null) or ("billing_payments"."source" = 'bank_import' and "billing_payments"."import_row_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "invoice_application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "invoice_application_status" NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"error_code" text,
	"actor_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_application_events_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_application_events_line_attempt_uq" UNIQUE("tenant_id","invoice_line_id","attempt"),
	CONSTRAINT "invoice_application_events_attempt_positive" CHECK ("invoice_application_events"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"format" text NOT NULL,
	"status" "billing_document_status" DEFAULT 'pending' NOT NULL,
	"object_key" text,
	"content_type" text,
	"sha256" text,
	"byte_size" integer,
	"renderer_version" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_documents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_documents_invoice_revision_format_uq" UNIQUE("invoice_id","revision","format"),
	CONSTRAINT "invoice_documents_revision_positive" CHECK ("invoice_documents"."revision" > 0),
	CONSTRAINT "invoice_documents_format_check" CHECK ("invoice_documents"."format" in ('pdf', 'html')),
	CONSTRAINT "invoice_documents_ready_metadata_check" CHECK ("invoice_documents"."status" <> 'ready' or ("invoice_documents"."object_key" is not null and "invoice_documents"."sha256" is not null and "invoice_documents"."byte_size" is not null))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "invoice_line_kind" NOT NULL,
	"catalog_version_id" uuid,
	"catalog_kind" "catalog_item_kind",
	"name_ru" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ru" text,
	"description_en" text,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"catalog_unit_price" numeric(14, 2),
	"agreed_unit_price" numeric(14, 2) NOT NULL,
	"vat_rate" numeric(5, 2),
	"vat_included" boolean NOT NULL,
	"line_subtotal" numeric(14, 2) NOT NULL,
	"line_vat" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"activation_policy" "invoice_activation_policy",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_lines_invoice_position_uq" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_lines_position_positive" CHECK ("invoice_lines"."position" > 0),
	CONSTRAINT "invoice_lines_quantity_positive" CHECK ("invoice_lines"."quantity" > 0),
	CONSTRAINT "invoice_lines_prices_nonnegative" CHECK ("invoice_lines"."agreed_unit_price" >= 0 and "invoice_lines"."line_subtotal" >= 0 and "invoice_lines"."line_vat" >= 0 and "invoice_lines"."line_total" >= 0),
	CONSTRAINT "invoice_lines_catalog_kind_check" CHECK (("invoice_lines"."kind" = 'custom' and "invoice_lines"."catalog_version_id" is null and "invoice_lines"."catalog_kind" is null) or ("invoice_lines"."kind" <> 'custom' and "invoice_lines"."catalog_version_id" is not null and "invoice_lines"."catalog_kind" is not null)),
	CONSTRAINT "invoice_lines_activation_policy_check" CHECK (("invoice_lines"."kind" in ('plan', 'addon') and "invoice_lines"."activation_policy" is not null) or ("invoice_lines"."kind" in ('service', 'custom') and "invoice_lines"."activation_policy" is null))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issue_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"seller_snapshot" jsonb,
	"buyer_snapshot" jsonb,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"application_mode" "invoice_application_mode" DEFAULT 'manual' NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"issued_by_platform_user_id" text,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_uq" UNIQUE("number"),
	CONSTRAINT "invoices_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_currency_rub_check" CHECK ("invoices"."currency" = 'RUB'),
	CONSTRAINT "invoices_totals_nonnegative" CHECK ("invoices"."subtotal" >= 0 and "invoices"."vat_total" >= 0 and "invoices"."total" >= 0),
	CONSTRAINT "invoices_issued_snapshot_check" CHECK ("invoices"."status" = 'draft' or ("invoices"."issue_date" is not null and "invoices"."seller_snapshot" is not null and "invoices"."buyer_snapshot" is not null))
);
--> statement-breakpoint
CREATE TABLE "operator_billing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"kind" "billing_profile_kind" NOT NULL,
	"display_name" text NOT NULL,
	"inn" text,
	"kpp" text,
	"ogrn" text,
	"ogrnip" text,
	"address_raw" text NOT NULL,
	"address" jsonb,
	"bank_details" jsonb,
	"contact" jsonb,
	"created_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_billing_profiles_revision_uq" UNIQUE("revision"),
	CONSTRAINT "operator_billing_profiles_revision_positive" CHECK ("operator_billing_profiles"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"source_row_id" text NOT NULL,
	"operation_date" timestamp with time zone,
	"amount" numeric(14, 2),
	"currency" text,
	"payer_name" text,
	"payment_purpose" text,
	"bank_reference" text,
	"raw_fields" jsonb,
	"parse_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_import_rows_import_source_uq" UNIQUE("import_id","source_row_id"),
	CONSTRAINT "payment_import_rows_amount_nonnegative" CHECK ("payment_import_rows"."amount" is null or "payment_import_rows"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "billing_payment_source" DEFAULT 'bank_import' NOT NULL,
	"source_checksum" text NOT NULL,
	"file_name" text,
	"parser_version" text NOT NULL,
	"status" "payment_import_status" DEFAULT 'processing' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_imports_source_checksum_uq" UNIQUE("source_checksum"),
	CONSTRAINT "payment_imports_source_check" CHECK ("payment_imports"."source" = 'bank_import'),
	CONSTRAINT "payment_imports_counts_nonnegative" CHECK ("payment_imports"."row_count" >= 0 and "payment_imports"."error_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_row_id" uuid NOT NULL,
	"tenant_id" text,
	"invoice_id" uuid,
	"status" "payment_match_status" DEFAULT 'unmatched' NOT NULL,
	"score" integer,
	"reason" text,
	"decided_by_platform_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_matches_import_row_uq" UNIQUE("import_row_id"),
	CONSTRAINT "payment_matches_score_check" CHECK ("payment_matches"."score" is null or ("payment_matches"."score" >= 0 and "payment_matches"."score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "tenant_billing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"revision" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"kind" "billing_profile_kind" NOT NULL,
	"display_name" text NOT NULL,
	"inn" text,
	"kpp" text,
	"ogrn" text,
	"ogrnip" text,
	"address_raw" text NOT NULL,
	"address" jsonb,
	"bank_details" jsonb,
	"contact" jsonb,
	"created_by_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_profiles_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_billing_profiles_revision_uq" UNIQUE("tenant_id","revision"),
	CONSTRAINT "tenant_billing_profiles_revision_positive" CHECK ("tenant_billing_profiles"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_import_row_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."payment_import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_application_events" ADD CONSTRAINT "invoice_application_events_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_application_events" ADD CONSTRAINT "invoice_application_events_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_application_events" ADD CONSTRAINT "invoice_application_events_tenant_line_fk" FOREIGN KEY ("tenant_id","invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_catalog_version_kind_fk" FOREIGN KEY ("catalog_version_id","catalog_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("issued_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_import_rows" ADD CONSTRAINT "payment_import_rows_import_fk" FOREIGN KEY ("import_id") REFERENCES "public"."payment_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_imports" ADD CONSTRAINT "payment_imports_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD CONSTRAINT "payment_matches_decided_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("decided_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD CONSTRAINT "payment_matches_import_row_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."payment_import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD CONSTRAINT "payment_matches_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD CONSTRAINT "tenant_billing_profiles_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD CONSTRAINT "tenant_billing_profiles_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_tenant_status_issued_idx" ON "invoices" USING btree ("tenant_id","status","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_billing_profiles_current_uq" ON "operator_billing_profiles" USING btree ("is_current") WHERE "operator_billing_profiles"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_profiles_current_uq" ON "tenant_billing_profiles" USING btree ("tenant_id") WHERE "tenant_billing_profiles"."is_current" = true;