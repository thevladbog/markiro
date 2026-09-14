CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TABLE "service_excess_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"service_period_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"original_approval_id" uuid,
	"minute_delta" integer NOT NULL,
	"external_reference" text NOT NULL,
	"external_url" text,
	"approved_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"actor_platform_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_excess_approvals_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_excess_approvals_tenant_request_id_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "service_excess_approvals_shape_check" CHECK ((
        "service_excess_approvals"."kind" = 'approval' and "service_excess_approvals"."original_approval_id" is null and "service_excess_approvals"."minute_delta" between 1 and 2147483647
      ) or (
        "service_excess_approvals"."kind" = 'withdrawal' and "service_excess_approvals"."original_approval_id" is not null and "service_excess_approvals"."minute_delta" between -2147483647 and -1
      )),
	CONSTRAINT "service_excess_approvals_text_check" CHECK (length(btrim("service_excess_approvals"."external_reference")) between 1 and 1000 and ("service_excess_approvals"."external_url" is null or length("service_excess_approvals"."external_url") between 1 and 2000) and length(btrim("service_excess_approvals"."reason")) between 1 and 1000),
	CONSTRAINT "service_excess_approvals_time_check" CHECK (isfinite("service_excess_approvals"."approved_at") and isfinite("service_excess_approvals"."posted_at")),
	CONSTRAINT "service_excess_approvals_request_hash_check" CHECK ("service_excess_approvals"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "service_excess_approvals_response_check" CHECK (jsonb_typeof("service_excess_approvals"."response") = 'object' and octet_length("service_excess_approvals"."response"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "service_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"ordered_service_id" uuid NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"billing_timezone" text NOT NULL,
	"renewal_anchor" jsonb NOT NULL,
	"commercial_snapshot" jsonb NOT NULL,
	"allowance_snapshot" jsonb NOT NULL,
	"included_minutes" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_periods_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_periods_tenant_invoice_line_uq" UNIQUE("tenant_id","invoice_line_id"),
	CONSTRAINT "service_periods_time_check" CHECK (isfinite("service_periods"."starts_at") and isfinite("service_periods"."ends_at") and isfinite("service_periods"."created_at") and "service_periods"."ends_at" > "service_periods"."starts_at"),
	CONSTRAINT "service_periods_timezone_check" CHECK ("service_periods"."billing_timezone" = 'Europe/Moscow'),
	CONSTRAINT "service_periods_json_check" CHECK (jsonb_typeof("service_periods"."renewal_anchor") = 'object' and jsonb_typeof("service_periods"."commercial_snapshot") = 'object' and jsonb_typeof("service_periods"."allowance_snapshot") = 'object'),
	CONSTRAINT "service_periods_included_minutes_check" CHECK ("service_periods"."included_minutes" between 1 and 100000),
	CONSTRAINT "service_periods_revision_check" CHECK ("service_periods"."revision" between 1 and 2147483647)
);
--> statement-breakpoint
CREATE TABLE "service_usage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"service_period_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"classification" text NOT NULL,
	"original_entry_id" uuid,
	"work_reference" text NOT NULL,
	"description" text NOT NULL,
	"internal_note" text,
	"actual_minutes_delta" integer NOT NULL,
	"allowance_minutes_delta" integer NOT NULL,
	"performed_at" timestamp with time zone NOT NULL,
	"actor_platform_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_usage_entries_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_usage_entries_tenant_request_id_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "service_usage_entries_shape_check" CHECK ((
        "service_usage_entries"."kind" = 'usage'
        and "service_usage_entries"."original_entry_id" is null
        and "service_usage_entries"."actual_minutes_delta" between 1 and 2147483647
        and "service_usage_entries"."allowance_minutes_delta" between 0 and 2147483647
        and ("service_usage_entries"."classification" = 'customer_service' or ("service_usage_entries"."classification" = 'product_defect' and "service_usage_entries"."allowance_minutes_delta" = 0))
      ) or (
        "service_usage_entries"."kind" = 'correction'
        and "service_usage_entries"."original_entry_id" is not null
        and "service_usage_entries"."classification" in ('customer_service', 'product_defect')
        and "service_usage_entries"."actual_minutes_delta" between -2147483647 and 2147483647
        and "service_usage_entries"."allowance_minutes_delta" between -2147483647 and 2147483647
        and ("service_usage_entries"."actual_minutes_delta" <> 0 or "service_usage_entries"."allowance_minutes_delta" <> 0)
      )),
	CONSTRAINT "service_usage_entries_text_check" CHECK (length(btrim("service_usage_entries"."work_reference")) between 1 and 300 and length(btrim("service_usage_entries"."description")) between 1 and 4000 and ("service_usage_entries"."internal_note" is null or length(btrim("service_usage_entries"."internal_note")) <= 4000)),
	CONSTRAINT "service_usage_entries_time_check" CHECK (isfinite("service_usage_entries"."performed_at") and isfinite("service_usage_entries"."posted_at")),
	CONSTRAINT "service_usage_entries_request_hash_check" CHECK ("service_usage_entries"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "service_usage_entries_response_check" CHECK (jsonb_typeof("service_usage_entries"."response") = 'object' and octet_length("service_usage_entries"."response"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "catalog_item_versions" DROP CONSTRAINT "catalog_item_versions_kind_billing_check";--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD COLUMN "service_terms" jsonb;--> statement-breakpoint
ALTER TABLE "service_excess_approvals" ADD CONSTRAINT "service_excess_approvals_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_excess_approvals" ADD CONSTRAINT "service_excess_approvals_tenant_period_fk" FOREIGN KEY ("tenant_id","service_period_id") REFERENCES "public"."service_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_excess_approvals" ADD CONSTRAINT "service_excess_approvals_tenant_original_fk" FOREIGN KEY ("tenant_id","original_approval_id") REFERENCES "public"."service_excess_approvals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_tenant_ordered_service_fk" FOREIGN KEY ("tenant_id","ordered_service_id") REFERENCES "public"."ordered_services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_catalog_item_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_catalog_version_fk" FOREIGN KEY ("catalog_version_id") REFERENCES "public"."catalog_item_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_tenant_invoice_line_fk" FOREIGN KEY ("tenant_id","invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_tenant_payment_fk" FOREIGN KEY ("tenant_id","invoice_id","payment_id") REFERENCES "public"."billing_payments"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_usage_entries" ADD CONSTRAINT "service_usage_entries_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_usage_entries" ADD CONSTRAINT "service_usage_entries_tenant_period_fk" FOREIGN KEY ("tenant_id","service_period_id") REFERENCES "public"."service_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_usage_entries" ADD CONSTRAINT "service_usage_entries_tenant_original_fk" FOREIGN KEY ("tenant_id","original_entry_id") REFERENCES "public"."service_usage_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_excess_approvals_tenant_period_posted_idx" ON "service_excess_approvals" USING btree ("tenant_id","service_period_id","posted_at","id");--> statement-breakpoint
CREATE INDEX "service_periods_tenant_catalog_starts_idx" ON "service_periods" USING btree ("tenant_id","catalog_item_id","starts_at","id");--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "catalog_item_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&);--> statement-breakpoint
CREATE INDEX "service_usage_entries_tenant_period_posted_idx" ON "service_usage_entries" USING btree ("tenant_id","service_period_id","posted_at","id");--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_kind_billing_check" CHECK ((
        "catalog_item_versions"."kind" = 'service' and "catalog_item_versions"."billing_mode" = 'one_time' and "catalog_item_versions"."billing_period" is null and "catalog_item_versions"."service_terms" is null
      ) or (
        "catalog_item_versions"."kind" = 'service' and "catalog_item_versions"."billing_mode" = 'recurring' and "catalog_item_versions"."billing_period" = 'month' and jsonb_typeof("catalog_item_versions"."service_terms") = 'object'
      ) or (
        "catalog_item_versions"."kind" in ('plan', 'addon') and "catalog_item_versions"."billing_mode" = 'recurring' and "catalog_item_versions"."billing_period" is not null and "catalog_item_versions"."service_terms" is null
      )) NOT VALID;
