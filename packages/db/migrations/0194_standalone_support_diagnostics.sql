CREATE TABLE "standalone_support_diagnostics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"site_id" uuid,
	"host_key" text NOT NULL,
	"blob_sha256" text NOT NULL,
	"kid" text NOT NULL,
	"payload_version" smallint NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by_platform_user_id" text NOT NULL,
	"app_version" text,
	"host_version" text,
	"pc_role" text,
	"devices_station" integer NOT NULL,
	"devices_office" integer NOT NULL,
	"devices_handheld" integer NOT NULL,
	"license" jsonb,
	"payload" jsonb NOT NULL,
	CONSTRAINT "standalone_support_diagnostics_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "standalone_support_diagnostics_blob_uq" UNIQUE("blob_sha256"),
	CONSTRAINT "standalone_support_diagnostics_host_generated_uq" UNIQUE("tenant_id","host_key","generated_at"),
	CONSTRAINT "standalone_support_diagnostics_host_key_check" CHECK ("standalone_support_diagnostics"."host_key" = 'unknown' or "standalone_support_diagnostics"."host_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "standalone_support_diagnostics_blob_check" CHECK ("standalone_support_diagnostics"."blob_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "standalone_support_diagnostics_kid_check" CHECK (length("standalone_support_diagnostics"."kid") between 1 and 32),
	CONSTRAINT "standalone_support_diagnostics_version_check" CHECK ("standalone_support_diagnostics"."payload_version" in (1, 2)),
	CONSTRAINT "standalone_support_diagnostics_versions_check" CHECK (("standalone_support_diagnostics"."app_version" is null or length("standalone_support_diagnostics"."app_version") <= 64) and ("standalone_support_diagnostics"."host_version" is null or length("standalone_support_diagnostics"."host_version") <= 64)),
	CONSTRAINT "standalone_support_diagnostics_role_check" CHECK ("standalone_support_diagnostics"."pc_role" is null or "standalone_support_diagnostics"."pc_role" in ('host', 'station', 'office')),
	CONSTRAINT "standalone_support_diagnostics_devices_check" CHECK ("standalone_support_diagnostics"."devices_station" >= 0 and "standalone_support_diagnostics"."devices_office" >= 0 and "standalone_support_diagnostics"."devices_handheld" >= 0),
	CONSTRAINT "standalone_support_diagnostics_json_check" CHECK (jsonb_typeof("standalone_support_diagnostics"."payload") = 'object' and octet_length("standalone_support_diagnostics"."payload"::text) <= 65536 and ("standalone_support_diagnostics"."license" is null or (jsonb_typeof("standalone_support_diagnostics"."license") = 'object' and octet_length("standalone_support_diagnostics"."license"::text) <= 8192)))
);
--> statement-breakpoint
CREATE TABLE "standalone_support_usage_months" (
	"tenant_id" text NOT NULL,
	"host_key" text NOT NULL,
	"month" text NOT NULL,
	"stats" jsonb NOT NULL,
	"source_diagnostic_id" uuid NOT NULL,
	"source_generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "standalone_support_usage_months_pkey" PRIMARY KEY("tenant_id","host_key","month"),
	CONSTRAINT "standalone_support_usage_months_host_key_check" CHECK ("standalone_support_usage_months"."host_key" = 'unknown' or "standalone_support_usage_months"."host_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "standalone_support_usage_months_month_check" CHECK ("standalone_support_usage_months"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "standalone_support_usage_months_stats_check" CHECK (jsonb_typeof("standalone_support_usage_months"."stats") = 'object' and octet_length("standalone_support_usage_months"."stats"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "standalone_support_diagnostics" ADD CONSTRAINT "standalone_support_diagnostics_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_support_diagnostics" ADD CONSTRAINT "standalone_support_diagnostics_received_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("received_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_support_diagnostics" ADD CONSTRAINT "standalone_support_diagnostics_tenant_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."standalone_sites"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_support_usage_months" ADD CONSTRAINT "standalone_support_usage_months_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_support_usage_months" ADD CONSTRAINT "standalone_support_usage_months_source_fk" FOREIGN KEY ("tenant_id","source_diagnostic_id") REFERENCES "public"."standalone_support_diagnostics"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standalone_support_diagnostics_tenant_generated_idx" ON "standalone_support_diagnostics" USING btree ("tenant_id","generated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "standalone_support_diagnostics_tenant_host_generated_idx" ON "standalone_support_diagnostics" USING btree ("tenant_id","host_key","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "standalone_support_diagnostics_received_idx" ON "standalone_support_diagnostics" USING btree ("received_at");