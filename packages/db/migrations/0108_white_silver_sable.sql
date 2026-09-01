CREATE TYPE "public"."national_catalog_card_source_method" AS ENUM('legacy_unknown', 'feed_product', 'product');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_freshness_outcome" AS ENUM('changed', 'unchanged', 'not_modified', 'not_found', 'unauthorized', 'forbidden', 'rate_limited', 'invalid_response', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."product_regulatory_proposal_kind" AS ENUM('category_binding', 'category_change', 'national_catalog_import');--> statement-breakpoint
CREATE TABLE "national_catalog_card_freshness" (
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"card_id" text NOT NULL,
	"source_method" "national_catalog_card_source_method" NOT NULL,
	"latest_snapshot_id" uuid NOT NULL,
	"provider_etag" text,
	"content_hash" char(64) NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL,
	"last_outcome" "national_catalog_freshness_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "national_catalog_card_freshness_tenant_id_product_id_card_id_source_method_pk" PRIMARY KEY("tenant_id","product_id","card_id","source_method"),
	CONSTRAINT "national_catalog_card_freshness_source_method_ck" CHECK ("national_catalog_card_freshness"."source_method" <> 'legacy_unknown')
);
--> statement-breakpoint
CREATE TABLE "product_regulatory_binding_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"proposal_id" uuid,
	"prior_category_id" text,
	"prior_schema_version_id" uuid,
	"next_category_id" text NOT NULL,
	"next_schema_version_id" uuid NOT NULL,
	"resulting_revision" integer NOT NULL,
	"source" "product_attribute_source" NOT NULL,
	"source_ref" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_regulatory_binding_history_resulting_revision_ck" CHECK ("product_regulatory_binding_history"."resulting_revision" > 0)
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "national_catalog_schema_versions"
		GROUP BY "scope_key", "content_hash"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'cannot install scope-local schema uniqueness: duplicate scope/content rows exist';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "national_catalog_schema_versions" DROP CONSTRAINT "national_catalog_schema_versions_content_hash_uq";--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ADD COLUMN "source_method" "national_catalog_card_source_method";--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ADD COLUMN "payload_format_version" integer;--> statement-breakpoint
UPDATE "national_catalog_card_snapshots"
SET "source_method" = 'legacy_unknown',
	"payload_format_version" = 1;--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ALTER COLUMN "source_method" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ALTER COLUMN "payload_format_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ADD CONSTRAINT "national_catalog_card_snapshots_cursor_identity_uq" UNIQUE("tenant_id","product_id","card_id","source_method","id");--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD COLUMN "kind" "product_regulatory_proposal_kind";--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD COLUMN "terminal_reason" text;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD COLUMN "applied_selection" jsonb;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD COLUMN "applied_selection_hash" char(64);--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD COLUMN "rejected_by" text;--> statement-breakpoint
UPDATE "product_regulatory_proposals"
SET "kind" = 'category_change',
	"expires_at" = "created_at" + interval '24 hours';--> statement-breakpoint
DO $$
DECLARE
	proposal_record record;
	parsed_selection jsonb;
	entry_count integer;
	distinct_entry_count integer;
BEGIN
	FOR proposal_record IN
		SELECT "id", "source_ref"
		FROM "product_regulatory_proposals"
		WHERE "source" = 'manual'
			AND "status" = 'applied'
			AND "source_ref" IS NOT NULL
	LOOP
		BEGIN
			parsed_selection := proposal_record."source_ref"::jsonb;
		EXCEPTION WHEN others THEN
			CONTINUE;
		END;

		IF jsonb_typeof(parsed_selection) <> 'array' OR EXISTS (
			SELECT 1
			FROM jsonb_array_elements(parsed_selection) AS entry(value)
			WHERE jsonb_typeof(entry.value) <> 'string'
				OR (entry.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		) THEN
			CONTINUE;
		END IF;

		SELECT count(*), count(DISTINCT entry.value #>> '{}')
		INTO entry_count, distinct_entry_count
		FROM jsonb_array_elements(parsed_selection) AS entry(value);

		IF entry_count <> distinct_entry_count THEN
			CONTINUE;
		END IF;

		UPDATE "product_regulatory_proposals"
		SET "applied_selection" = parsed_selection,
			"source_ref" = NULL
		WHERE "id" = proposal_record."id";
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_tenant_product_id_uq" UNIQUE("tenant_id","product_id","id");--> statement-breakpoint
ALTER TABLE "national_catalog_card_freshness" ADD CONSTRAINT "national_catalog_card_freshness_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_card_freshness" ADD CONSTRAINT "national_catalog_card_freshness_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_card_freshness" ADD CONSTRAINT "national_catalog_card_freshness_snapshot_fk" FOREIGN KEY ("tenant_id","product_id","card_id","source_method","latest_snapshot_id") REFERENCES "public"."national_catalog_card_snapshots"("tenant_id","product_id","card_id","source_method","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_binding_history" ADD CONSTRAINT "product_regulatory_binding_history_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_binding_history" ADD CONSTRAINT "product_regulatory_binding_history_prior_schema_version_id_national_catalog_schema_versions_id_fk" FOREIGN KEY ("prior_schema_version_id") REFERENCES "public"."national_catalog_schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_binding_history" ADD CONSTRAINT "product_regulatory_binding_history_next_schema_version_id_national_catalog_schema_versions_id_fk" FOREIGN KEY ("next_schema_version_id") REFERENCES "public"."national_catalog_schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_binding_history" ADD CONSTRAINT "product_regulatory_binding_history_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_binding_history" ADD CONSTRAINT "product_regulatory_binding_history_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_binding_history" ADD CONSTRAINT "product_regulatory_binding_history_proposal_fk" FOREIGN KEY ("tenant_id","product_id","proposal_id") REFERENCES "public"."product_regulatory_proposals"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_rejected_by_user_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_schema_versions" ADD CONSTRAINT "national_catalog_schema_versions_scope_content_uq" UNIQUE("scope_key","content_hash");--> statement-breakpoint
ALTER TABLE "national_catalog_card_snapshots" ADD CONSTRAINT "national_catalog_card_snapshots_payload_format_version_ck" CHECK ("national_catalog_card_snapshots"."payload_format_version" >= 1);--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_base_revision_ck" CHECK ("product_regulatory_proposals"."base_revision" >= 0);--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_applied_selection_ck" CHECK ("product_regulatory_proposals"."applied_selection" is null or jsonb_typeof("product_regulatory_proposals"."applied_selection") = 'array');--> statement-breakpoint
ALTER TABLE "product_regulatory_proposals" ADD CONSTRAINT "product_regulatory_proposals_applied_selection_hash_ck" CHECK ("product_regulatory_proposals"."applied_selection_hash" is null or "product_regulatory_proposals"."applied_selection" is not null);--> statement-breakpoint
UPDATE "product_regulatory_profiles"
SET "revision" = 1
WHERE "revision" <= 0;--> statement-breakpoint
INSERT INTO "product_regulatory_binding_history" (
	"tenant_id",
	"product_id",
	"proposal_id",
	"prior_category_id",
	"prior_schema_version_id",
	"next_category_id",
	"next_schema_version_id",
	"resulting_revision",
	"source",
	"source_ref",
	"actor_id",
	"created_at"
)
SELECT
	"tenant_id",
	"product_id",
	NULL,
	NULL,
	NULL,
	"category_id",
	"schema_version_id",
	"revision",
	'migration',
	NULL,
	NULL,
	"confirmed_at"
FROM "product_regulatory_profiles";
