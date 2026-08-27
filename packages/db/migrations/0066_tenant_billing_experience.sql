CREATE TYPE "public"."billing_act_status" AS ENUM('draft', 'issued', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."billing_actor_kind" AS ENUM('tenant_user', 'platform_user', 'system');--> statement-breakpoint
CREATE TYPE "public"."billing_request_event_kind" AS ENUM('created', 'status_changed', 'tenant_reply', 'platform_comment', 'offer_linked', 'offer_accepted', 'offer_changes_requested', 'invoice_linked', 'payment_confirmed', 'service_linked', 'act_linked');--> statement-breakpoint
CREATE TYPE "public"."billing_request_status" AS ENUM('new', 'under_review', 'clarification_required', 'offer_prepared', 'awaiting_payment', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."billing_request_type" AS ENUM('renewal', 'capacity_change', 'additional_service', 'documents', 'other');--> statement-breakpoint
CREATE TYPE "public"."billing_responsible_side" AS ENUM('tenant', 'markiro', 'none');--> statement-breakpoint
CREATE TYPE "public"."offer_decision_kind" AS ENUM('accepted', 'changes_requested');--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'partially_paid' BEFORE 'paid';--> statement-breakpoint
CREATE SEQUENCE "public"."tenant_billing_request_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing_act_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"act_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_act_documents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_act_documents_act_revision_uq" UNIQUE("tenant_id","act_id","revision"),
	CONSTRAINT "billing_act_documents_object_key_uq" UNIQUE("object_key"),
	CONSTRAINT "billing_act_documents_revision_positive" CHECK ("billing_act_documents"."revision" > 0),
	CONSTRAINT "billing_act_documents_byte_size_positive" CHECK ("billing_act_documents"."byte_size" > 0),
	CONSTRAINT "billing_act_documents_content_type_pdf" CHECK ("billing_act_documents"."content_type" = 'application/pdf')
);
--> statement-breakpoint
CREATE TABLE "billing_acts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid,
	"invoice_id" uuid,
	"ordered_service_id" uuid,
	"number" text NOT NULL,
	"status" "billing_act_status" DEFAULT 'draft' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"issued_by_platform_user_id" text,
	"issued_at" timestamp with time zone,
	"cancelled_by_platform_user_id" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_acts_number_uq" UNIQUE("number"),
	CONSTRAINT "billing_acts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_acts_period_order_check" CHECK ("billing_acts"."period_end" >= "billing_acts"."period_start"),
	CONSTRAINT "billing_acts_issue_shape_check" CHECK (("billing_acts"."status" = 'draft' and "billing_acts"."issued_by_platform_user_id" is null and "billing_acts"."issued_at" is null and "billing_acts"."cancelled_by_platform_user_id" is null and "billing_acts"."cancelled_at" is null)
        or ("billing_acts"."status" = 'issued' and "billing_acts"."issued_by_platform_user_id" is not null and "billing_acts"."issued_at" is not null and "billing_acts"."cancelled_by_platform_user_id" is null and "billing_acts"."cancelled_at" is null)
        or ("billing_acts"."status" = 'cancelled' and "billing_acts"."cancelled_by_platform_user_id" is not null and "billing_acts"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "commercial_offer_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"decision" "offer_decision_kind" NOT NULL,
	"message" text,
	"actor_user_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_offer_decisions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "commercial_offer_decisions_tenant_idempotency_uq" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "commercial_offer_decisions_message_shape_check" CHECK ("commercial_offer_decisions"."decision" <> 'changes_requested' or nullif(btrim("commercial_offer_decisions"."message"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "tenant_billing_request_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_request_attachments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_billing_request_attachments_object_key_uq" UNIQUE("object_key"),
	CONSTRAINT "tenant_billing_request_attachments_byte_size_positive" CHECK ("tenant_billing_request_attachments"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_billing_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" "billing_request_event_kind" NOT NULL,
	"from_status" "billing_request_status",
	"to_status" "billing_request_status",
	"actor_kind" "billing_actor_kind" NOT NULL,
	"actor_user_id" text,
	"actor_platform_user_id" text,
	"message" text,
	"metadata" jsonb,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_request_events_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_billing_request_events_tenant_idempotency_uq" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tenant_billing_request_events_actor_shape_check" CHECK (("tenant_billing_request_events"."actor_kind" = 'tenant_user' and "tenant_billing_request_events"."actor_user_id" is not null and "tenant_billing_request_events"."actor_platform_user_id" is null)
        or ("tenant_billing_request_events"."actor_kind" = 'platform_user' and "tenant_billing_request_events"."actor_user_id" is null and "tenant_billing_request_events"."actor_platform_user_id" is not null)
        or ("tenant_billing_request_events"."actor_kind" = 'system' and "tenant_billing_request_events"."actor_user_id" is null and "tenant_billing_request_events"."actor_platform_user_id" is null)),
	CONSTRAINT "tenant_billing_request_events_status_shape_check" CHECK ("tenant_billing_request_events"."kind" <> 'status_changed' or ("tenant_billing_request_events"."from_status" is not null and "tenant_billing_request_events"."to_status" is not null and "tenant_billing_request_events"."from_status" <> "tenant_billing_request_events"."to_status"))
);
--> statement-breakpoint
CREATE TABLE "tenant_billing_request_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"offer_id" uuid,
	"invoice_id" uuid,
	"payment_id" uuid,
	"act_id" uuid,
	"ordered_service_id" uuid,
	"subscription_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_request_links_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_billing_request_links_one_target_check" CHECK (num_nonnulls("tenant_billing_request_links"."offer_id", "tenant_billing_request_links"."invoice_id", "tenant_billing_request_links"."payment_id", "tenant_billing_request_links"."act_id", "tenant_billing_request_links"."ordered_service_id", "tenant_billing_request_links"."subscription_event_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "tenant_billing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"number" text NOT NULL,
	"type" "billing_request_type" NOT NULL,
	"status" "billing_request_status" DEFAULT 'new' NOT NULL,
	"description" text NOT NULL,
	"desired_at" timestamp with time zone,
	"context_type" text,
	"context_id" text,
	"responsible_side" "billing_responsible_side" DEFAULT 'markiro' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_requests_number_uq" UNIQUE("number"),
	CONSTRAINT "tenant_billing_requests_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_billing_requests_tenant_idempotency_uq" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tenant_billing_requests_context_shape_check" CHECK (("tenant_billing_requests"."context_type" is null) = ("tenant_billing_requests"."context_id" is null)),
	CONSTRAINT "tenant_billing_requests_description_nonempty" CHECK (nullif(btrim("tenant_billing_requests"."description"), '') is not null)
);
--> statement-breakpoint
ALTER TABLE "billing_payments" DROP CONSTRAINT "billing_payments_invoice_uq";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "source_offer_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD CONSTRAINT "billing_act_documents_uploaded_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("uploaded_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD CONSTRAINT "billing_act_documents_tenant_act_fk" FOREIGN KEY ("tenant_id","act_id") REFERENCES "public"."billing_acts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_issued_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("issued_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_cancelled_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("cancelled_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_tenant_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."tenant_billing_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_acts" ADD CONSTRAINT "billing_acts_tenant_service_fk" FOREIGN KEY ("tenant_id","ordered_service_id") REFERENCES "public"."ordered_services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offer_decisions" ADD CONSTRAINT "commercial_offer_decisions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offer_decisions" ADD CONSTRAINT "commercial_offer_decisions_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ADD CONSTRAINT "tenant_billing_request_attachments_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ADD CONSTRAINT "tenant_billing_request_attachments_tenant_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."tenant_billing_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_events" ADD CONSTRAINT "tenant_billing_request_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_events" ADD CONSTRAINT "tenant_billing_request_events_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_events" ADD CONSTRAINT "tenant_billing_request_events_tenant_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."tenant_billing_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."tenant_billing_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."billing_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_act_fk" FOREIGN KEY ("tenant_id","act_id") REFERENCES "public"."billing_acts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_service_fk" FOREIGN KEY ("tenant_id","ordered_service_id") REFERENCES "public"."ordered_services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_links" ADD CONSTRAINT "tenant_billing_request_links_tenant_subscription_event_fk" FOREIGN KEY ("tenant_id","subscription_event_id") REFERENCES "public"."subscription_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_requests" ADD CONSTRAINT "tenant_billing_requests_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_requests" ADD CONSTRAINT "tenant_billing_requests_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_act_documents_current_act_uq" ON "billing_act_documents" USING btree ("tenant_id","act_id") WHERE "billing_act_documents"."is_current" = true;--> statement-breakpoint
CREATE INDEX "billing_acts_tenant_status_created_idx" ON "billing_acts" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_offer_decisions_accepted_offer_uq" ON "commercial_offer_decisions" USING btree ("tenant_id","offer_id") WHERE "commercial_offer_decisions"."decision" = 'accepted';--> statement-breakpoint
CREATE INDEX "commercial_offer_decisions_tenant_offer_created_idx" ON "commercial_offer_decisions" USING btree ("tenant_id","offer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tenant_billing_request_events_tenant_request_created_idx" ON "tenant_billing_request_events" USING btree ("tenant_id","request_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_offer_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","request_id","offer_id") WHERE "tenant_billing_request_links"."offer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_invoice_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","request_id","invoice_id") WHERE "tenant_billing_request_links"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_payment_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","request_id","payment_id") WHERE "tenant_billing_request_links"."payment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_act_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","request_id","act_id") WHERE "tenant_billing_request_links"."act_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_service_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","request_id","ordered_service_id") WHERE "tenant_billing_request_links"."ordered_service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_subscription_event_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","request_id","subscription_event_id") WHERE "tenant_billing_request_links"."subscription_event_id" is not null;--> statement-breakpoint
CREATE INDEX "tenant_billing_requests_tenant_status_updated_idx" ON "tenant_billing_requests" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_source_offer_fk" FOREIGN KEY ("tenant_id","source_offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_payments_tenant_invoice_paid_idx" ON "billing_payments" USING btree ("tenant_id","invoice_id","paid_at","id");
