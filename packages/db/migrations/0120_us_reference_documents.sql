CREATE TYPE "public"."reference_document_type" AS ENUM('bol', 'po', 'asn', 'work_order', 'invoice', 'database_record', 'batch_log', 'production_log', 'other');--> statement-breakpoint
CREATE TABLE "reference_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"type" "reference_document_type" NOT NULL,
	"type_other_label" text,
	"number" text NOT NULL,
	"party_id" uuid,
	"issued_on" date,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_documents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "reference_documents_number_valid" CHECK (length("reference_documents"."number") BETWEEN 1 AND 128 AND "reference_documents"."number" = btrim("reference_documents"."number") AND "reference_documents"."number" !~ U&'[\0001-\001F\007F-\009F]'),
	CONSTRAINT "reference_documents_other_shape" CHECK (("reference_documents"."type" = 'other' AND "reference_documents"."type_other_label" IS NOT NULL) OR ("reference_documents"."type" <> 'other' AND "reference_documents"."type_other_label" IS NULL)),
	CONSTRAINT "reference_documents_other_label_valid" CHECK (length(btrim("reference_documents"."type_other_label")) BETWEEN 1 AND 200 AND "reference_documents"."type_other_label" !~ U&'[\0001-\001F\007F-\009F]'),
	CONSTRAINT "reference_documents_notes_valid" CHECK (length(btrim("reference_documents"."notes")) BETWEEN 1 AND 2000),
	CONSTRAINT "reference_documents_date_range" CHECK ("reference_documents"."issued_on" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
	CONSTRAINT "reference_documents_actor_valid" CHECK (length(btrim("reference_documents"."created_by")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "reference_documents" ADD CONSTRAINT "reference_documents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD CONSTRAINT "reference_documents_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."traceability_parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reference_documents_without_party_uq" ON "reference_documents" USING btree ("tenant_id","type","number") WHERE "reference_documents"."party_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reference_documents_with_party_uq" ON "reference_documents" USING btree ("tenant_id","type","party_id","number") WHERE "reference_documents"."party_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reference_documents_tenant_party_idx" ON "reference_documents" USING btree ("tenant_id","party_id");