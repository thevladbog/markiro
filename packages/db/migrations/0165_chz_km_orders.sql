CREATE TYPE "public"."chz_km_order_state" AS ENUM('created', 'signing', 'submitted', 'buffer_pending', 'buffer_active', 'fetching', 'completed', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "chz_km_codes" (
	"tenant_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"encrypted_code" "bytea" NOT NULL,
	"code_nonce" "bytea" NOT NULL,
	"code_tag" "bytea" NOT NULL,
	"code_hash" char(64) NOT NULL,
	"block_id" uuid NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chz_km_codes_tenant_id_order_id_seq_pk" PRIMARY KEY("tenant_id","order_id","seq"),
	CONSTRAINT "chz_km_codes_seq_check" CHECK ("chz_km_codes"."seq" >= 1),
	CONSTRAINT "chz_km_codes_hash_check" CHECK ("chz_km_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chz_km_codes_status_check" CHECK (("chz_km_codes"."status" = 'available' and "chz_km_codes"."issue_id" is null) or ("chz_km_codes"."status" = 'issued' and "chz_km_codes"."issue_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "chz_km_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"format" text,
	"from_seq" integer NOT NULL,
	"to_seq" integer NOT NULL,
	"count" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chz_km_issues_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "chz_km_issues_kind_check" CHECK ("chz_km_issues"."kind" in ('export', 'print')),
	CONSTRAINT "chz_km_issues_format_check" CHECK (("chz_km_issues"."kind" = 'export' and "chz_km_issues"."format" in ('txt', 'csv')) or ("chz_km_issues"."kind" = 'print' and "chz_km_issues"."format" is null)),
	CONSTRAINT "chz_km_issues_range_check" CHECK ("chz_km_issues"."from_seq" >= 1 and "chz_km_issues"."to_seq" >= "chz_km_issues"."from_seq" and "chz_km_issues"."count" = "chz_km_issues"."to_seq" - "chz_km_issues"."from_seq" + 1)
);
--> statement-breakpoint
CREATE TABLE "chz_km_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"gtin14" char(14) NOT NULL,
	"product_group_alias" text NOT NULL,
	"product_group_code" integer NOT NULL,
	"template_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"state" "chz_km_order_state" DEFAULT 'created' NOT NULL,
	"request_body" text NOT NULL,
	"signer_task_id" uuid,
	"oms_order_id" uuid,
	"buffer_status" text,
	"buffer_expires_at" timestamp with time zone,
	"available_codes" integer,
	"total_passed" integer,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"issued_count" integer DEFAULT 0 NOT NULL,
	"rejection_reason" text,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chz_km_orders_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "chz_km_orders_quantity_check" CHECK ("chz_km_orders"."quantity" between 1 and 150000),
	CONSTRAINT "chz_km_orders_counts_check" CHECK ("chz_km_orders"."issued_count" >= 0 and "chz_km_orders"."issued_count" <= "chz_km_orders"."fetched_count" and "chz_km_orders"."fetched_count" <= "chz_km_orders"."quantity" and "chz_km_orders"."attempts" >= 0),
	CONSTRAINT "chz_km_orders_state_consistency_check" CHECK (("chz_km_orders"."state" = 'created' and "chz_km_orders"."oms_order_id" is null and "chz_km_orders"."error_code" is null)
        or ("chz_km_orders"."state" = 'signing' and "chz_km_orders"."signer_task_id" is not null and "chz_km_orders"."oms_order_id" is null and "chz_km_orders"."error_code" is null)
        or ("chz_km_orders"."state" in ('submitted', 'buffer_pending', 'buffer_active', 'fetching') and "chz_km_orders"."oms_order_id" is not null and "chz_km_orders"."error_code" is null)
        or ("chz_km_orders"."state" = 'completed' and "chz_km_orders"."oms_order_id" is not null and "chz_km_orders"."fetched_count" = "chz_km_orders"."quantity" and "chz_km_orders"."error_code" is null)
        or ("chz_km_orders"."state" = 'rejected' and "chz_km_orders"."oms_order_id" is not null and "chz_km_orders"."rejection_reason" is not null)
        or ("chz_km_orders"."state" = 'failed' and "chz_km_orders"."error_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "chz_oms_tokens" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"encrypted_token" "bytea" NOT NULL,
	"token_nonce" "bytea" NOT NULL,
	"token_tag" "bytea" NOT NULL,
	"source_oms_connection" text NOT NULL,
	"source_true_api_base_url" text NOT NULL,
	"obtained_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"agent_id" uuid,
	"cert_thumbprint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "label_templates" DROP CONSTRAINT "label_templates_purpose_check";--> statement-breakpoint
ALTER TABLE "chz_km_codes" ADD CONSTRAINT "chz_km_codes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_codes" ADD CONSTRAINT "chz_km_codes_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."chz_km_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_codes" ADD CONSTRAINT "chz_km_codes_tenant_issue_fk" FOREIGN KEY ("tenant_id","issue_id") REFERENCES "public"."chz_km_issues"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_issues" ADD CONSTRAINT "chz_km_issues_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_issues" ADD CONSTRAINT "chz_km_issues_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_issues" ADD CONSTRAINT "chz_km_issues_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."chz_km_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_orders" ADD CONSTRAINT "chz_km_orders_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_orders" ADD CONSTRAINT "chz_km_orders_product_group_code_chz_product_groups_code_fk" FOREIGN KEY ("product_group_code") REFERENCES "public"."chz_product_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_orders" ADD CONSTRAINT "chz_km_orders_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_km_orders" ADD CONSTRAINT "chz_km_orders_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_oms_tokens" ADD CONSTRAINT "chz_oms_tokens_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_oms_tokens" ADD CONSTRAINT "chz_oms_tokens_tenant_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."chz_signer_agents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chz_km_codes_tenant_hash_uq" ON "chz_km_codes" USING btree ("tenant_id","code_hash");--> statement-breakpoint
CREATE INDEX "chz_km_codes_available_idx" ON "chz_km_codes" USING btree ("tenant_id","order_id","seq") WHERE "chz_km_codes"."status" = 'available';--> statement-breakpoint
CREATE INDEX "chz_km_issues_order_idx" ON "chz_km_issues" USING btree ("tenant_id","order_id","created_at");--> statement-breakpoint
CREATE INDEX "chz_km_orders_tenant_created_idx" ON "chz_km_orders" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "chz_km_orders_unfinished_idx" ON "chz_km_orders" USING btree ("tenant_id") WHERE "chz_km_orders"."state" not in ('completed', 'rejected', 'failed');--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_purpose_check" CHECK ("label_templates"."purpose" IN ('box', 'product_duplicate', 'pallet', 'product_km'));
--> statement-breakpoint
-- Stock KM label for tenants that already exist; new tenants get it from
-- tenant-provisioning.service.ts (`buildKmLabelTemplates()`). (tenant_id,
-- name, purpose) is the seed identity, so a re-run cannot duplicate it.
INSERT INTO label_templates (id, tenant_id, name, purpose, spec)
SELECT gen_random_uuid(), o.id, 'Этикетка КМ 58×40', 'product_km', '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[{"kind":"barcode","id":"km","xMm":2,"yMm":2,"format":"datamatrix","data":"km.code","sizeMm":24},{"kind":"field","id":"name","xMm":28,"yMm":3,"field":"product.printName","fontSizePt":9,"bold":true,"maxWidthMm":28,"maxLines":3},{"kind":"text","id":"cap-gtin","xMm":28,"yMm":19,"text":"GTIN","fontSizePt":5,"maxWidthMm":28},{"kind":"field","id":"gtin","xMm":28,"yMm":21.5,"field":"product.gtin","fontSizePt":7,"maxWidthMm":28},{"kind":"field","id":"serial","xMm":2,"yMm":29,"field":"km.code","textFormat":"km_without_crypto","fontSizePt":6,"maxWidthMm":54,"maxLines":1}]}'::jsonb
FROM organization o
WHERE NOT EXISTS (
  SELECT 1 FROM label_templates lt
  WHERE lt.tenant_id = o.id AND lt.name = 'Этикетка КМ 58×40' AND lt.purpose = 'product_km'
);
