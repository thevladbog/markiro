CREATE TYPE "public"."national_catalog_category_group_mapping_state" AS ENUM('exact', 'ambiguous', 'unmapped');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_schema_status" AS ENUM('observed', 'validated', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."product_attribute_source" AS ENUM('manual', '1c', 'national_catalog', 'migration');--> statement-breakpoint
CREATE TYPE "public"."product_attribute_state" AS ENUM('active', 'inapplicable');--> statement-breakpoint
CREATE TYPE "public"."product_regulatory_proposal_status" AS ENUM('preview', 'applied', 'rejected', 'stale');--> statement-breakpoint
CREATE TABLE "national_catalog_attribute_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version_id" uuid NOT NULL,
	"source_attribute_id" text NOT NULL,
	"target_field" text NOT NULL,
	"conversion" jsonb NOT NULL,
	"mapping_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "national_catalog_attribute_mappings_target_uq" UNIQUE("schema_version_id","source_attribute_id","target_field")
);
--> statement-breakpoint
CREATE TABLE "national_catalog_card_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"gtin14" char(14) NOT NULL,
	"card_id" text NOT NULL,
	"card_status" text NOT NULL,
	"etag" text,
	"content_hash" char(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "national_catalog_card_snapshots_tenant_product_id_uq" UNIQUE("tenant_id","product_id","id"),
	CONSTRAINT "national_catalog_card_snapshots_content_uq" UNIQUE("tenant_id","product_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "national_catalog_category_group_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chz_product_group_code" integer NOT NULL,
	"schema_version_id" uuid,
	"category_id" text,
	"state" "national_catalog_category_group_mapping_state" NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "national_catalog_category_group_mappings_candidate_uq" UNIQUE("chz_product_group_code","schema_version_id"),
	CONSTRAINT "national_catalog_category_group_mappings_state_ck" CHECK (("national_catalog_category_group_mappings"."state" = 'unmapped' and "national_catalog_category_group_mappings"."category_id" is null and "national_catalog_category_group_mappings"."schema_version_id" is null) or ("national_catalog_category_group_mappings"."state" <> 'unmapped' and "national_catalog_category_group_mappings"."category_id" is not null and "national_catalog_category_group_mappings"."schema_version_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "national_catalog_schema_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_key" text NOT NULL,
	"category_id" text NOT NULL,
	"category_name" text NOT NULL,
	"selectors" jsonb NOT NULL,
	"source_version" text,
	"etag" text,
	"content_hash" char(64) NOT NULL,
	"definition" jsonb NOT NULL,
	"status" "national_catalog_schema_status" DEFAULT 'observed' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"validated_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "national_catalog_schema_versions_content_hash_uq" UNIQUE("content_hash")
);
--> statement-breakpoint
CREATE TABLE "product_egais_codes" (
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"code" char(19) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"source" "product_attribute_source" NOT NULL,
	"source_ref" text,
	"observed_at" timestamp with time zone,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_egais_codes_tenant_id_product_id_code_pk" PRIMARY KEY("tenant_id","product_id","code"),
	CONSTRAINT "product_egais_codes_digits_ck" CHECK ("product_egais_codes"."code" ~ '^[0-9]{19}$')
);
--> statement-breakpoint
CREATE TABLE "product_regulatory_attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"schema_version_id" uuid NOT NULL,
	"attribute_id" text NOT NULL,
	"value" jsonb NOT NULL,
	"state" "product_attribute_state" DEFAULT 'active' NOT NULL,
	"source" "product_attribute_source" NOT NULL,
	"source_ref" text,
	"observed_at" timestamp with time zone,
	"applied_by" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_regulatory_profiles" (
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"category_id" text NOT NULL,
	"category_name" text NOT NULL,
	"tn_ved_code" text,
	"okpd2_code" text,
	"schema_version_id" uuid NOT NULL,
	"source" "product_attribute_source" NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_regulatory_profiles_tenant_id_product_id_pk" PRIMARY KEY("tenant_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "product_regulatory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"source" "product_attribute_source" NOT NULL,
	"source_ref" text,
	"base_revision" integer NOT NULL,
	"diff" jsonb NOT NULL,
	"status" "product_regulatory_proposal_status" DEFAULT 'preview' NOT NULL,
	"created_by" text,
	"applied_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"stale_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "national_catalog_attribute_mappings" ADD CONSTRAINT "national_catalog_attribute_mappings_schema_version_id_national_catalog_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."national_catalog_schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ADD CONSTRAINT "national_catalog_card_snapshots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ADD CONSTRAINT "national_catalog_card_snapshots_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_category_group_mappings" ADD CONSTRAINT "national_catalog_category_group_mappings_chz_product_group_code_chz_product_groups_code_fk" FOREIGN KEY ("chz_product_group_code") REFERENCES "public"."chz_product_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_category_group_mappings" ADD CONSTRAINT "national_catalog_category_group_mappings_schema_version_id_national_catalog_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."national_catalog_schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_category_group_mappings" ADD CONSTRAINT "national_catalog_category_group_mappings_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_egais_codes" ADD CONSTRAINT "product_egais_codes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_egais_codes" ADD CONSTRAINT "product_egais_codes_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_attribute_values" ADD CONSTRAINT "product_regulatory_attribute_values_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_attribute_values" ADD CONSTRAINT "product_regulatory_attribute_values_schema_version_id_national_catalog_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."national_catalog_schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_attribute_values" ADD CONSTRAINT "product_regulatory_attribute_values_applied_by_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_attribute_values" ADD CONSTRAINT "product_regulatory_attribute_values_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_schema_version_id_national_catalog_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."national_catalog_schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_applied_by_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_snapshot_fk" FOREIGN KEY ("tenant_id","product_id","snapshot_id") REFERENCES "public"."national_catalog_card_snapshots"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "national_catalog_category_group_mappings_unmapped_uq" ON "national_catalog_category_group_mappings" USING btree ("chz_product_group_code") WHERE "national_catalog_category_group_mappings"."state" = 'unmapped';--> statement-breakpoint
CREATE UNIQUE INDEX "national_catalog_schema_versions_active_scope_uq" ON "national_catalog_schema_versions" USING btree ("scope_key") WHERE "national_catalog_schema_versions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "product_egais_codes_primary_uq" ON "product_egais_codes" USING btree ("tenant_id","product_id") WHERE "product_egais_codes"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "product_regulatory_attribute_values_current_uq" ON "product_regulatory_attribute_values" USING btree ("tenant_id","product_id","attribute_id") WHERE "product_regulatory_attribute_values"."superseded_at" is null;
--> statement-breakpoint
INSERT INTO "product_egais_codes" ("tenant_id", "product_id", "code", "is_primary", "source")
SELECT "tenant_id", "id", "egais_code", true, 'migration'
FROM "products"
WHERE "egais_code" ~ '^[0-9]{19}$'
ON CONFLICT DO NOTHING;
