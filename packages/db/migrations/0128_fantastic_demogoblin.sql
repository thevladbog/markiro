CREATE TYPE "public"."platform_agreement_document_kind" AS ENUM('draft', 'generated', 'attachment');--> statement-breakpoint
CREATE TYPE "public"."platform_agreement_status" AS ENUM('draft', 'in_review', 'sent', 'signed', 'terminated');--> statement-breakpoint
CREATE TABLE "platform_agreement_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"kind" "platform_agreement_document_kind" NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"renderer_version" text,
	"uploaded_by_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_agreement_documents_object_key_uq" UNIQUE("object_key"),
	CONSTRAINT "platform_agreement_documents_checksum_format" CHECK ("platform_agreement_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_agreement_documents_size_positive" CHECK ("platform_agreement_documents"."byte_size" > 0),
	CONSTRAINT "platform_agreement_documents_provenance" CHECK (("platform_agreement_documents"."kind" = 'attachment' and "platform_agreement_documents"."uploaded_by_platform_user_id" is not null and "platform_agreement_documents"."renderer_version" is null) or ("platform_agreement_documents"."kind" in ('draft', 'generated') and "platform_agreement_documents"."uploaded_by_platform_user_id" is null and "platform_agreement_documents"."renderer_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "platform_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"status" "platform_agreement_status" DEFAULT 'draft' NOT NULL,
	"conclusion_date" date,
	"city" text,
	"tenant_id" text,
	"counterparty_inn" text,
	"counterparty" jsonb NOT NULL,
	"contractor" jsonb NOT NULL,
	"terms" jsonb NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_snapshot" jsonb,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"created_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_agreements_number_uq" UNIQUE("number"),
	CONSTRAINT "platform_agreements_signed_consistency" CHECK (("platform_agreements"."status" in ('signed', 'terminated')) = ("platform_agreements"."signed_snapshot" is not null and "platform_agreements"."signed_at" is not null)),
	CONSTRAINT "platform_agreements_terminated_consistency" CHECK (("platform_agreements"."status" = 'terminated') = ("platform_agreements"."terminated_at" is not null)),
	CONSTRAINT "platform_agreements_termination_reason_consistency" CHECK (("platform_agreements"."terminated_at" is null) = ("platform_agreements"."termination_reason" is null)),
	CONSTRAINT "platform_agreements_inn_format" CHECK ("platform_agreements"."counterparty_inn" is null or "platform_agreements"."counterparty_inn" ~ '^[0-9]{10}$|^[0-9]{12}$')
);
--> statement-breakpoint
ALTER TABLE "platform_agreement_documents" ADD CONSTRAINT "platform_agreement_documents_agreement_id_platform_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."platform_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agreement_documents" ADD CONSTRAINT "platform_agreement_documents_uploader_fk" FOREIGN KEY ("uploaded_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agreements" ADD CONSTRAINT "platform_agreements_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agreements" ADD CONSTRAINT "platform_agreements_creator_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_agreement_documents_agreement_idx" ON "platform_agreement_documents" USING btree ("agreement_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_agreements_status_idx" ON "platform_agreements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_agreements_tenant_idx" ON "platform_agreements" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "platform_agreements_counterparty_inn_idx" ON "platform_agreements" USING btree ("counterparty_inn");