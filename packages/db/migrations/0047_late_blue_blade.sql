CREATE TYPE "public"."disaggregation_document_status" AS ENUM('draft', 'applied', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."disaggregation_line_status" AS ENUM('ok', 'not_found', 'not_closed', 'shift_open', 'already_disassembled', 'written_off', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."disaggregation_source" AS ENUM('manual', 'import');--> statement-breakpoint
CREATE TABLE "disaggregation_doc_counters" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disaggregation_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"sscc_input" text NOT NULL,
	"sscc" char(18),
	"box_id" uuid,
	"status" "disaggregation_line_status" NOT NULL,
	"product_id" uuid,
	"code_count" integer DEFAULT 0 NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disaggregation_document_lines_doc_sscc_uq" UNIQUE("tenant_id","document_id","sscc")
);
--> statement-breakpoint
CREATE TABLE "disaggregation_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"doc_no" text NOT NULL,
	"status" "disaggregation_document_status" DEFAULT 'draft' NOT NULL,
	"reason_id" uuid,
	"comment" text,
	"source" "disaggregation_source" DEFAULT 'manual' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by_user_id" text,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disaggregation_documents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "disaggregation_documents_tenant_doc_no_uq" UNIQUE("tenant_id","doc_no"),
	CONSTRAINT "disaggregation_documents_applied_fields_check" CHECK (("disaggregation_documents"."status" = 'applied') = ("disaggregation_documents"."applied_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "disaggregation_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disaggregation_reasons_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD COLUMN "disaggregation_document_id" uuid;--> statement-breakpoint
ALTER TABLE "disaggregation_doc_counters" ADD CONSTRAINT "disaggregation_doc_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD CONSTRAINT "disaggregation_document_lines_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD CONSTRAINT "disaggregation_document_lines_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."disaggregation_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD CONSTRAINT "disaggregation_document_lines_tenant_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD CONSTRAINT "disaggregation_document_lines_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_documents" ADD CONSTRAINT "disaggregation_documents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_documents" ADD CONSTRAINT "disaggregation_documents_tenant_reason_fk" FOREIGN KEY ("tenant_id","reason_id") REFERENCES "public"."disaggregation_reasons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_reasons" ADD CONSTRAINT "disaggregation_reasons_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disaggregation_document_lines_tenant_doc_idx" ON "disaggregation_document_lines" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "disaggregation_documents_tenant_created_idx" ON "disaggregation_documents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "code_registry_tenant_scanned_idx" ON "code_registry" USING btree ("tenant_id","scanned_at");--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD CONSTRAINT "box_exceptions_tenant_disaggregation_document_fk" FOREIGN KEY ("tenant_id","disaggregation_document_id") REFERENCES "disaggregation_documents"("tenant_id","id");