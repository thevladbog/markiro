CREATE TYPE "public"."national_catalog_environment" AS ENUM('production', 'sandbox');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_access" AS ENUM('own', 'provided');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_image_result" AS ENUM('none', 'pending', 'applied', 'unchanged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_image_state" AS ENUM('pending', 'ready', 'failed', 'released');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_match" AS ENUM('new', 'existing', 'linked', 'other_link', 'archived_local', 'ambiguous', 'invalid', 'inaccessible', 'not_found');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_mode" AS ENUM('own_catalog', 'gtins');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_operation_state" AS ENUM('pending', 'running', 'finished', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_product_result" AS ENUM('pending', 'applied', 'conflict', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_import_session_state" AS ENUM('queued', 'loading', 'ready', 'partial', 'blocked', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_link_outcome" AS ENUM('ok', 'error', 'never');--> statement-breakpoint
CREATE TYPE "public"."national_catalog_status_key" AS ENUM('draft', 'moderation', 'errors', 'unsigned', 'published', 'archived', 'unknown');--> statement-breakpoint
CREATE TABLE "national_catalog_import_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_hash" char(64) NOT NULL,
	"source_url" text,
	"staged_asset_id" uuid,
	"checksum" char(64),
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"state" "national_catalog_import_image_state" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_import_images_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_images_preview_id_uq" UNIQUE("tenant_id","session_id","preview_id","id"),
	CONSTRAINT "nc_import_images_candidate_uq" UNIQUE("tenant_id","session_id","preview_id","candidate_id"),
	CONSTRAINT "nc_import_images_dimensions_ck" CHECK (("national_catalog_import_images"."byte_size" is null or "national_catalog_import_images"."byte_size" between 1 and 5242880) and ("national_catalog_import_images"."width" is null or "national_catalog_import_images"."width" between 1 and 1200) and ("national_catalog_import_images"."height" is null or "national_catalog_import_images"."height" between 1 and 1200)),
	CONSTRAINT "nc_import_images_ready_ck" CHECK ("national_catalog_import_images"."state" <> 'ready' or ("national_catalog_import_images"."staged_asset_id" is not null and "national_catalog_import_images"."checksum" is not null and "national_catalog_import_images"."byte_size" is not null and "national_catalog_import_images"."width" is not null and "national_catalog_import_images"."height" is not null))
);
--> statement-breakpoint
CREATE TABLE "national_catalog_import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"input" text,
	"gtin14" char(14),
	"card_id" text,
	"name" text,
	"brand" text,
	"status_keys" "national_catalog_status_key"[] DEFAULT '{}' NOT NULL,
	"raw_status" text,
	"raw_detailed_statuses" text[] DEFAULT '{}' NOT NULL,
	"match" "national_catalog_import_match" NOT NULL,
	"product_id" uuid,
	"selected" boolean DEFAULT false NOT NULL,
	"selectable" boolean DEFAULT false NOT NULL,
	"reason" text,
	"access" "national_catalog_import_access",
	"source" jsonb,
	"source_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_import_items_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_items_session_id_uq" UNIQUE("tenant_id","session_id","id"),
	CONSTRAINT "nc_import_items_gtin_ck" CHECK ("national_catalog_import_items"."gtin14" is null or "national_catalog_import_items"."gtin14" ~ '^[0-9]{14}$'),
	CONSTRAINT "nc_import_items_selected_ck" CHECK (not "national_catalog_import_items"."selected" or "national_catalog_import_items"."selectable")
);
--> statement-breakpoint
CREATE TABLE "national_catalog_import_operation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"decision" jsonb NOT NULL,
	"product_id" uuid,
	"product_result" "national_catalog_import_product_result" DEFAULT 'pending' NOT NULL,
	"image_result" "national_catalog_import_image_result" DEFAULT 'none' NOT NULL,
	"accepted_image_id" uuid,
	"image_retry_eligible" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"image_error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"image_attempts" integer DEFAULT 0 NOT NULL,
	"next_image_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_import_operation_items_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_operation_items_preview_uq" UNIQUE("tenant_id","operation_id","preview_id"),
	CONSTRAINT "nc_import_operation_items_attempts_ck" CHECK ("national_catalog_import_operation_items"."attempts" >= 0 and "national_catalog_import_operation_items"."image_attempts" >= 0),
	CONSTRAINT "nc_import_operation_items_retry_ck" CHECK (not "national_catalog_import_operation_items"."image_retry_eligible" or ("national_catalog_import_operation_items"."accepted_image_id" is not null and "national_catalog_import_operation_items"."image_result" in ('pending', 'failed'))),
	CONSTRAINT "nc_import_operation_items_applied_ck" CHECK ("national_catalog_import_operation_items"."product_result" <> 'applied' or "national_catalog_import_operation_items"."product_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "national_catalog_import_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"decision_hash" char(64) NOT NULL,
	"state" "national_catalog_import_operation_state" DEFAULT 'pending' NOT NULL,
	"enqueue_pending" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "nc_import_operations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_operations_session_id_uq" UNIQUE("tenant_id","session_id","id"),
	CONSTRAINT "nc_import_operations_request_uq" UNIQUE("tenant_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "national_catalog_import_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"product_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"source" jsonb,
	"source_hash" char(64) NOT NULL,
	"expected_product_revision" text,
	"expected_profile_revision" integer,
	"expected_link_revision" integer,
	"expected_schema_revision" text,
	"previous_values" jsonb,
	"previous_photo" jsonb,
	"diff" jsonb,
	"manual_provenance" jsonb,
	"category_options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_purged_at" timestamp with time zone,
	CONSTRAINT "nc_import_previews_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_previews_session_id_uq" UNIQUE("tenant_id","session_id","id"),
	CONSTRAINT "nc_import_previews_source_uq" UNIQUE("tenant_id","session_id","id","source_hash"),
	CONSTRAINT "nc_import_previews_revisions_ck" CHECK (("national_catalog_import_previews"."expected_profile_revision" is null or "national_catalog_import_previews"."expected_profile_revision" >= 0) and ("national_catalog_import_previews"."expected_link_revision" is null or "national_catalog_import_previews"."expected_link_revision" >= 0))
);
--> statement-breakpoint
CREATE TABLE "national_catalog_import_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"environment" "national_catalog_environment" NOT NULL,
	"mode" "national_catalog_import_mode" NOT NULL,
	"state" "national_catalog_import_session_state" DEFAULT 'queued' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"through_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"loaded" integer DEFAULT 0 NOT NULL,
	"selected" integer DEFAULT 0 NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"interval_stack" jsonb,
	"cursor" jsonb,
	"checkpoint" jsonb,
	"catch_up_boundary" timestamp with time zone,
	"incomplete_reason" text,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_import_sessions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_sessions_counts_ck" CHECK ("national_catalog_import_sessions"."loaded" between 0 and 100000 and "national_catalog_import_sessions"."selected" between 0 and "national_catalog_import_sessions"."loaded"),
	CONSTRAINT "nc_import_sessions_revision_ck" CHECK ("national_catalog_import_sessions"."revision" > 0),
	CONSTRAINT "nc_import_sessions_expiry_ck" CHECK ("national_catalog_import_sessions"."expires_at" > "national_catalog_import_sessions"."started_at")
);
--> statement-breakpoint
CREATE TABLE "national_catalog_product_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"environment" "national_catalog_environment" NOT NULL,
	"card_id" text NOT NULL,
	"bound_gtin14" char(14) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"latest_snapshot_id" uuid,
	"reviewed_snapshot_id" uuid,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_outcome" "national_catalog_link_outcome" DEFAULT 'never' NOT NULL,
	"raw_status" text,
	"raw_detailed_statuses" text[] DEFAULT '{}' NOT NULL,
	"status_keys" "national_catalog_status_key"[] DEFAULT '{}' NOT NULL,
	"observed_meaningful_hash" char(64),
	"reviewed_meaningful_hash" char(64),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_product_links_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_product_links_revision_ck" CHECK ("national_catalog_product_links"."revision" > 0),
	CONSTRAINT "nc_product_links_gtin_ck" CHECK ("national_catalog_product_links"."bound_gtin14" ~ '^[0-9]{14}$'),
	CONSTRAINT "nc_product_links_closed_ck" CHECK (("national_catalog_product_links"."closed_at" is null and "national_catalog_product_links"."closed_by" is null and "national_catalog_product_links"."closed_reason" is null) or ("national_catalog_product_links"."closed_at" is not null and "national_catalog_product_links"."closed_by" is not null and "national_catalog_product_links"."closed_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "national_catalog_request_leases" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"owner" uuid NOT NULL,
	"fence" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL,
	"total_quota" jsonb,
	"method_quotas" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_request_leases_fence_ck" CHECK ("national_catalog_request_leases"."fence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "national_catalog_import_images" ADD CONSTRAINT "national_catalog_import_images_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_images" ADD CONSTRAINT "nc_import_images_source_fk" FOREIGN KEY ("tenant_id","session_id","preview_id","source_hash") REFERENCES "public"."national_catalog_import_previews"("tenant_id","session_id","id","source_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_images" ADD CONSTRAINT "nc_import_images_asset_fk" FOREIGN KEY ("tenant_id","staged_asset_id") REFERENCES "public"."media_assets"("owner_tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_items" ADD CONSTRAINT "national_catalog_import_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_items" ADD CONSTRAINT "nc_import_items_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."national_catalog_import_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_items" ADD CONSTRAINT "nc_import_items_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operation_items" ADD CONSTRAINT "national_catalog_import_operation_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operation_items" ADD CONSTRAINT "nc_import_operation_items_operation_fk" FOREIGN KEY ("tenant_id","session_id","operation_id") REFERENCES "public"."national_catalog_import_operations"("tenant_id","session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operation_items" ADD CONSTRAINT "nc_import_operation_items_preview_fk" FOREIGN KEY ("tenant_id","session_id","preview_id") REFERENCES "public"."national_catalog_import_previews"("tenant_id","session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operation_items" ADD CONSTRAINT "nc_import_operation_items_image_fk" FOREIGN KEY ("tenant_id","session_id","preview_id","accepted_image_id") REFERENCES "public"."national_catalog_import_images"("tenant_id","session_id","preview_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operation_items" ADD CONSTRAINT "nc_import_operation_items_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operations" ADD CONSTRAINT "national_catalog_import_operations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operations" ADD CONSTRAINT "national_catalog_import_operations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_operations" ADD CONSTRAINT "nc_import_operations_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."national_catalog_import_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_previews" ADD CONSTRAINT "national_catalog_import_previews_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_previews" ADD CONSTRAINT "nc_import_previews_item_fk" FOREIGN KEY ("tenant_id","session_id","item_id") REFERENCES "public"."national_catalog_import_items"("tenant_id","session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_previews" ADD CONSTRAINT "nc_import_previews_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_sessions" ADD CONSTRAINT "national_catalog_import_sessions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_sessions" ADD CONSTRAINT "national_catalog_import_sessions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD CONSTRAINT "national_catalog_product_links_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD CONSTRAINT "national_catalog_product_links_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD CONSTRAINT "national_catalog_product_links_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD CONSTRAINT "nc_product_links_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD CONSTRAINT "nc_product_links_latest_snapshot_fk" FOREIGN KEY ("tenant_id","product_id","latest_snapshot_id") REFERENCES "public"."national_catalog_card_snapshots"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_product_links" ADD CONSTRAINT "nc_product_links_reviewed_snapshot_fk" FOREIGN KEY ("tenant_id","product_id","reviewed_snapshot_id") REFERENCES "public"."national_catalog_card_snapshots"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_request_leases" ADD CONSTRAINT "national_catalog_request_leases_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nc_import_images_expiry_idx" ON "national_catalog_import_images" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nc_import_items_card_gtin_uq" ON "national_catalog_import_items" USING btree ("tenant_id","session_id","card_id","gtin14") WHERE "national_catalog_import_items"."card_id" is not null and "national_catalog_import_items"."gtin14" is not null;--> statement-breakpoint
CREATE INDEX "nc_import_operations_enqueue_idx" ON "national_catalog_import_operations" USING btree ("created_at") WHERE "national_catalog_import_operations"."enqueue_pending" = true;--> statement-breakpoint
CREATE INDEX "nc_import_previews_expiry_idx" ON "national_catalog_import_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "nc_import_sessions_expiry_idx" ON "national_catalog_import_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "national_catalog_product_links_current" ON "national_catalog_product_links" USING btree ("tenant_id","product_id") WHERE "national_catalog_product_links"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "nc_product_links_status_idx" ON "national_catalog_product_links" USING gin ("status_keys") WHERE "national_catalog_product_links"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "nc_product_links_freshness_idx" ON "national_catalog_product_links" USING btree ("last_attempt_at") WHERE "national_catalog_product_links"."closed_at" is null;