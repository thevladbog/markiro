CREATE TABLE "standalone_license_issuances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"entitlement_revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"compact" text NOT NULL,
	"sha256" text NOT NULL,
	"kid" text NOT NULL,
	"grace_days" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"valid_until_reason" text NOT NULL,
	"replaces_id" uuid,
	"issued_by_platform_user_id" text NOT NULL,
	CONSTRAINT "standalone_license_issuances_site_sequence_uq" UNIQUE("site_id","sequence"),
	CONSTRAINT "standalone_license_issuances_site_id_uq" UNIQUE("site_id","id"),
	CONSTRAINT "standalone_license_issuances_tenant_site_request_uq" UNIQUE("tenant_id","site_id","request_id"),
	CONSTRAINT "standalone_license_issuances_shape_check" CHECK ("standalone_license_issuances"."sequence" > 0 and "standalone_license_issuances"."grace_days" between 0 and 60 and "standalone_license_issuances"."plan" in ('demo','subscription') and ("standalone_license_issuances"."plan" <> 'demo' or "standalone_license_issuances"."grace_days" = 0) and "standalone_license_issuances"."sha256" ~ '^[0-9a-f]{64}$' and length(btrim("standalone_license_issuances"."kid")) between 1 and 128 and octet_length("standalone_license_issuances"."compact") between 1 and 16384 and "standalone_license_issuances"."entitlement_revision" >= 0 and "standalone_license_issuances"."valid_until_reason" in ('subscription_end','entitlement_reduction','one_year_cap','offline_term') and "standalone_license_issuances"."source" in ('subscription','offline') and (("standalone_license_issuances"."source" = 'offline') = ("standalone_license_issuances"."valid_until_reason" = 'offline_term')) and ("standalone_license_issuances"."source" <> 'offline' or "standalone_license_issuances"."plan" = 'subscription')),
	CONSTRAINT "standalone_license_issuances_interval_check" CHECK (isfinite("standalone_license_issuances"."issued_at") and isfinite("standalone_license_issuances"."valid_from") and isfinite("standalone_license_issuances"."valid_until") and "standalone_license_issuances"."issued_at" = "standalone_license_issuances"."valid_from" and "standalone_license_issuances"."valid_until" > "standalone_license_issuances"."valid_from" and "standalone_license_issuances"."valid_until" - "standalone_license_issuances"."valid_from" <= interval '365 days'),
	CONSTRAINT "standalone_license_issuances_payload_check" CHECK (jsonb_typeof("standalone_license_issuances"."payload") = 'object' and octet_length("standalone_license_issuances"."payload"::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "standalone_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"host_id" uuid NOT NULL,
	"name" text NOT NULL,
	"request_inn" text,
	"last_activation_request" jsonb NOT NULL,
	"host_history" jsonb NOT NULL,
	"last_issued_sequence" integer DEFAULT 0 NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standalone_sites_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "standalone_sites_host_id_uq" UNIQUE("host_id"),
	CONSTRAINT "standalone_sites_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "standalone_sites_name_check" CHECK (length(btrim("standalone_sites"."name")) between 1 and 200),
	CONSTRAINT "standalone_sites_request_inn_check" CHECK ("standalone_sites"."request_inn" is null or "standalone_sites"."request_inn" ~ '^[0-9]{10}([0-9]{2})?$'),
	CONSTRAINT "standalone_sites_sequence_check" CHECK ("standalone_sites"."last_issued_sequence" >= 0),
	CONSTRAINT "standalone_sites_payload_check" CHECK (jsonb_typeof("standalone_sites"."last_activation_request") = 'object' and octet_length("standalone_sites"."last_activation_request"::text) <= 65536 and case when jsonb_typeof("standalone_sites"."host_history") = 'array' then jsonb_array_length("standalone_sites"."host_history") between 1 and 100 else false end)
);
--> statement-breakpoint
ALTER TABLE "standalone_license_issuances" ADD CONSTRAINT "standalone_license_issuances_issued_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("issued_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_license_issuances" ADD CONSTRAINT "standalone_license_issuances_tenant_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."standalone_sites"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_license_issuances" ADD CONSTRAINT "standalone_license_issuances_site_replaces_fk" FOREIGN KEY ("site_id","replaces_id") REFERENCES "public"."standalone_license_issuances"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_sites" ADD CONSTRAINT "standalone_sites_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_sites" ADD CONSTRAINT "standalone_sites_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standalone_license_issuances_tenant_site_idx" ON "standalone_license_issuances" USING btree ("tenant_id","site_id","sequence");