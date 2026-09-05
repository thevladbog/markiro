CREATE TYPE "public"."traceability_profile_code" AS ENUM('RU_CHZ', 'US_FSMA204_PROCESSOR', 'US_GENERIC_LOT_TRACEABILITY');--> statement-breakpoint
CREATE TABLE "traceability_profiles" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"code" "traceability_profile_code" NOT NULL,
	"baseline_version" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_years" integer DEFAULT 5 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_profiles_baseline_for_us" CHECK ("traceability_profiles"."code" = 'RU_CHZ' OR ("traceability_profiles"."baseline_version" IS NOT NULL AND length(btrim("traceability_profiles"."baseline_version")) > 0)),
	CONSTRAINT "traceability_profiles_retention_min" CHECK ("traceability_profiles"."retention_years" >= 2)
);
--> statement-breakpoint
ALTER TABLE "traceability_profiles" ADD CONSTRAINT "traceability_profiles_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_profiles" ADD CONSTRAINT "traceability_profiles_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Compatibility for pre-existing RU organizations only. New tenants must provision
-- an explicit edition-allowed code; there is deliberately no column default.
INSERT INTO "traceability_profiles" ("tenant_id", "code", "effective_at")
SELECT "id", 'RU_CHZ', "created_at" FROM "organization"
ON CONFLICT ("tenant_id") DO NOTHING;
