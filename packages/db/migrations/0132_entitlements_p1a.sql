ALTER TYPE "public"."saas_entitlement_key" ADD VALUE 'chzIntegration';--> statement-breakpoint
ALTER TYPE "public"."saas_entitlement_key" ADD VALUE 'inventory';--> statement-breakpoint
ALTER TYPE "public"."saas_entitlement_key" ADD VALUE 'commerceMl';--> statement-breakpoint
ALTER TYPE "public"."saas_entitlement_key" ADD VALUE 'handheld';--> statement-breakpoint
CREATE TABLE "entitlement_lifecycle_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"decision_reference" text,
	"approved_at" timestamp with time zone,
	"approved_by_platform_user_id" text,
	"created_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_lifecycle_policies_key_version_uq" UNIQUE("policy_key","version"),
	CONSTRAINT "entitlement_lifecycle_policies_version_check" CHECK ("entitlement_lifecycle_policies"."version" > 0 and length(btrim("entitlement_lifecycle_policies"."policy_key")) between 1 and 100),
	CONSTRAINT "entitlement_lifecycle_policies_payload_check" CHECK (jsonb_typeof("entitlement_lifecycle_policies"."payload") = 'object' and octet_length("entitlement_lifecycle_policies"."payload"::text) <= 65536 and "entitlement_lifecycle_policies"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "entitlement_lifecycle_policies_approval_check" CHECK (("entitlement_lifecycle_policies"."status" = 'draft' and "entitlement_lifecycle_policies"."approved_at" is null and "entitlement_lifecycle_policies"."approved_by_platform_user_id" is null) or ("entitlement_lifecycle_policies"."status" = 'approved' and "entitlement_lifecycle_policies"."approved_at" is not null and isfinite("entitlement_lifecycle_policies"."approved_at") and "entitlement_lifecycle_policies"."approved_by_platform_user_id" is not null and "entitlement_lifecycle_policies"."decision_reference" is not null and length(btrim("entitlement_lifecycle_policies"."decision_reference")) between 1 and 1000))
);
--> statement-breakpoint
CREATE TABLE "entitlement_revisions" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"usage_revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_revisions_nonnegative_check" CHECK ("entitlement_revisions"."revision" >= 0 and "entitlement_revisions"."usage_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "entitlement_shadow_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"registry_version" text NOT NULL,
	"revision" bigint,
	"usage_revision" bigint,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"request_id" text,
	"resource_scope" jsonb NOT NULL,
	"fenced_attempt" integer,
	"lifecycle_policy_fingerprint" text,
	CONSTRAINT "entitlement_shadow_identity_check" CHECK (length(btrim("entitlement_shadow_observations"."operation_id")) between 1 and 100 and length(btrim("entitlement_shadow_observations"."registry_version")) between 1 and 100 and length(btrim("entitlement_shadow_observations"."actor_type")) between 1 and 100 and "entitlement_shadow_observations"."outcome" in ('allow','deny','unknown','error') and ("entitlement_shadow_observations"."revision" is null or "entitlement_shadow_observations"."revision" >= 0) and ("entitlement_shadow_observations"."usage_revision" is null or "entitlement_shadow_observations"."usage_revision" >= 0) and ("entitlement_shadow_observations"."fenced_attempt" is null or "entitlement_shadow_observations"."fenced_attempt" > 0) and ("entitlement_shadow_observations"."lifecycle_policy_fingerprint" is null or "entitlement_shadow_observations"."lifecycle_policy_fingerprint" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "entitlement_shadow_payload_check" CHECK (case when jsonb_typeof("entitlement_shadow_observations"."reason_codes") = 'array' then jsonb_array_length("entitlement_shadow_observations"."reason_codes") <= 64 and octet_length("entitlement_shadow_observations"."reason_codes"::text) <= 8192 else false end and jsonb_typeof("entitlement_shadow_observations"."resource_scope") = 'object' and octet_length("entitlement_shadow_observations"."resource_scope"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "entitlement_source_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"revision" bigint NOT NULL,
	"usage_revision" bigint NOT NULL,
	"usage_fingerprint" text NOT NULL,
	"registry_version" text NOT NULL,
	"lifecycle_policy_fingerprint" text NOT NULL,
	"next_change_at" timestamp with time zone,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"result_source_id" uuid,
	CONSTRAINT "entitlement_previews_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "entitlement_previews_identity_check" CHECK ("entitlement_source_previews"."intent" in ('prepare','revoke') and "entitlement_source_previews"."payload_hash" ~ '^[0-9a-f]{64}$' and "entitlement_source_previews"."usage_fingerprint" ~ '^[0-9a-f]{64}$' and "entitlement_source_previews"."lifecycle_policy_fingerprint" ~ '^[0-9a-f]{64}$' and length(btrim("entitlement_source_previews"."registry_version")) between 1 and 100 and "entitlement_source_previews"."revision" >= 0 and "entitlement_source_previews"."usage_revision" >= 0),
	CONSTRAINT "entitlement_previews_payload_check" CHECK (jsonb_typeof("entitlement_source_previews"."payload") = 'object' and octet_length("entitlement_source_previews"."payload"::text) <= 32768 and jsonb_typeof("entitlement_source_previews"."before_snapshot") = 'object' and octet_length("entitlement_source_previews"."before_snapshot"::text) <= 1048576 and jsonb_typeof("entitlement_source_previews"."after_snapshot") = 'object' and octet_length("entitlement_source_previews"."after_snapshot"::text) <= 1048576),
	CONSTRAINT "entitlement_previews_interval_check" CHECK (isfinite("entitlement_source_previews"."created_at") and isfinite("entitlement_source_previews"."expires_at") and "entitlement_source_previews"."expires_at" > "entitlement_source_previews"."created_at" and ("entitlement_source_previews"."next_change_at" is null or (isfinite("entitlement_source_previews"."next_change_at") and "entitlement_source_previews"."next_change_at" > "entitlement_source_previews"."created_at" and "entitlement_source_previews"."expires_at" <= "entitlement_source_previews"."next_change_at"))),
	CONSTRAINT "entitlement_previews_result_check" CHECK (("entitlement_source_previews"."confirmed_at" is null and "entitlement_source_previews"."result_source_id" is null) or ("entitlement_source_previews"."confirmed_at" is not null and "entitlement_source_previews"."result_source_id" is not null and isfinite("entitlement_source_previews"."confirmed_at") and "entitlement_source_previews"."confirmed_at" >= "entitlement_source_previews"."created_at" and "entitlement_source_previews"."confirmed_at" < "entitlement_source_previews"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "entitlement_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effects" jsonb NOT NULL,
	"operation_ids" jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"prepared" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"decision_reference" text NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_platform_user_id" text,
	"revocation_reason" text,
	"revocation_decision_reference" text,
	"revocation_request_id" uuid,
	CONSTRAINT "entitlement_sources_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "entitlement_sources_version_id_uq" UNIQUE("version_id"),
	CONSTRAINT "entitlement_sources_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "entitlement_sources_kind_version_check" CHECK ("entitlement_sources"."kind" in ('temporary','compatibility') and "entitlement_sources"."version" > 0 and "entitlement_sources"."prepared" = true),
	CONSTRAINT "entitlement_sources_interval_check" CHECK (isfinite("entitlement_sources"."starts_at") and ("entitlement_sources"."ends_at" is null or (isfinite("entitlement_sources"."ends_at") and "entitlement_sources"."ends_at" > "entitlement_sources"."starts_at")) and ("entitlement_sources"."kind" <> 'temporary' or "entitlement_sources"."ends_at" is not null)),
	CONSTRAINT "entitlement_sources_effects_check" CHECK (case when jsonb_typeof("entitlement_sources"."effects") = 'array' then jsonb_array_length("entitlement_sources"."effects") between 1 and 11 and octet_length("entitlement_sources"."effects"::text) <= 8192 else false end),
	CONSTRAINT "entitlement_sources_operations_check" CHECK (case when jsonb_typeof("entitlement_sources"."operation_ids") = 'array' then jsonb_array_length("entitlement_sources"."operation_ids") between 1 and 64 and octet_length("entitlement_sources"."operation_ids"::text) <= 8192 else false end),
	CONSTRAINT "entitlement_sources_compatibility_check" CHECK ("entitlement_sources"."kind" <> 'compatibility' or "entitlement_sources"."effects" <@ '[{"key":"chzIntegration","featureEnabled":true},{"key":"inventory","featureEnabled":true},{"key":"commerceMl","featureEnabled":true},{"key":"handheld","featureEnabled":true}]'::jsonb),
	CONSTRAINT "entitlement_sources_reason_check" CHECK (length(btrim("entitlement_sources"."reason")) between 1 and 1000 and length(btrim("entitlement_sources"."decision_reference")) between 1 and 1000),
	CONSTRAINT "entitlement_sources_revocation_check" CHECK (("entitlement_sources"."revoked_at" is null and "entitlement_sources"."revoked_by_platform_user_id" is null and "entitlement_sources"."revocation_reason" is null and "entitlement_sources"."revocation_decision_reference" is null and "entitlement_sources"."revocation_request_id" is null) or ("entitlement_sources"."revoked_at" is not null and isfinite("entitlement_sources"."revoked_at") and "entitlement_sources"."revoked_at" >= "entitlement_sources"."created_at" and "entitlement_sources"."revoked_by_platform_user_id" is not null and "entitlement_sources"."revocation_request_id" is not null and "entitlement_sources"."revocation_reason" is not null and length(btrim("entitlement_sources"."revocation_reason")) between 1 and 1000 and "entitlement_sources"."revocation_decision_reference" is not null and length(btrim("entitlement_sources"."revocation_decision_reference")) between 1 and 1000))
);
--> statement-breakpoint
ALTER TABLE "addon_entitlements" DROP CONSTRAINT "addon_entitlements_key_shape_check";--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD COLUMN "lifecycle_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD COLUMN "chz_integration_enabled" boolean;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD COLUMN "inventory_enabled" boolean;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD COLUMN "commerce_ml_enabled" boolean;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD COLUMN "handheld_enabled" boolean;--> statement-breakpoint
ALTER TABLE "entitlement_lifecycle_policies" ADD CONSTRAINT "entitlement_lifecycle_policies_approved_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("approved_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_lifecycle_policies" ADD CONSTRAINT "entitlement_lifecycle_policies_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_revisions" ADD CONSTRAINT "entitlement_revisions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_shadow_observations" ADD CONSTRAINT "entitlement_shadow_observations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_source_previews" ADD CONSTRAINT "entitlement_source_previews_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_source_previews" ADD CONSTRAINT "entitlement_previews_tenant_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_source_previews" ADD CONSTRAINT "entitlement_previews_tenant_result_fk" FOREIGN KEY ("tenant_id","result_source_id") REFERENCES "public"."entitlement_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_sources" ADD CONSTRAINT "entitlement_sources_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_sources" ADD CONSTRAINT "entitlement_sources_revoked_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("revoked_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_sources" ADD CONSTRAINT "entitlement_sources_tenant_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_shadow_tenant_observed_idx" ON "entitlement_shadow_observations" USING btree ("tenant_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_sources_tenant_revoke_request_uq" ON "entitlement_sources" USING btree ("tenant_id","revocation_request_id") WHERE "entitlement_sources"."revocation_request_id" is not null;--> statement-breakpoint
CREATE INDEX "entitlement_sources_tenant_subscription_idx" ON "entitlement_sources" USING btree ("tenant_id","subscription_id","starts_at");--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_lifecycle_policy_id_entitlement_lifecycle_policies_id_fk" FOREIGN KEY ("lifecycle_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_entitlements" ADD CONSTRAINT "addon_entitlements_key_shape_check" CHECK (("addon_entitlements"."entitlement_key"::text in ('lines', 'stations', 'kiosks', 'cabinetUsers') and "addon_entitlements"."quota_increment" is not null)
        or ("addon_entitlements"."entitlement_key"::text in ('labelEditor', 'publicApi', 'pallets', 'chzIntegration', 'inventory', 'commerceMl', 'handheld') and "addon_entitlements"."quota_increment" is null and "addon_entitlements"."feature_enabled" = true));--> statement-breakpoint
-- New enum values above are not cast back to the enum in this transaction.
-- The key-shape CHECK compares ::text, so fresh installs and upgrades can
-- apply the entire migration in Drizzle's single transaction.

-- Frozen grant identity/payload; revocation is a retained, one-way event.
CREATE FUNCTION entitlement_source_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by_platform_user_id','revocation_reason','revocation_decision_reference','revocation_request_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by_platform_user_id','revocation_reason','revocation_decision_reference','revocation_request_id'])
     OR (OLD.revoked_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Entitlement source terms and retained revocation are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entitlement_source_immutable BEFORE UPDATE ON entitlement_sources
FOR EACH ROW EXECUTE FUNCTION entitlement_source_immutable();
--> statement-breakpoint
CREATE FUNCTION entitlement_policy_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF TG_OP = 'DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'Approved lifecycle policy facts are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entitlement_policy_immutable BEFORE UPDATE OR DELETE ON entitlement_lifecycle_policies
FOR EACH ROW EXECUTE FUNCTION entitlement_policy_immutable();
--> statement-breakpoint
CREATE FUNCTION entitlement_preview_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['confirmed_at','result_source_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['confirmed_at','result_source_id'])
     OR (OLD.confirmed_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Entitlement preview payload and confirmation result are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entitlement_preview_immutable BEFORE UPDATE ON entitlement_source_previews
FOR EACH ROW EXECUTE FUNCTION entitlement_preview_immutable();
--> statement-breakpoint
-- Deleting a live tenant's revision row would reset it. Organization cascade
-- deletion is allowed after the parent row has disappeared in this transaction.
CREATE FUNCTION entitlement_revision_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM organization WHERE id = OLD.tenant_id) THEN
      RAISE EXCEPTION 'Cannot reset entitlement revision of a live tenant' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision < OLD.revision OR NEW.usage_revision < OLD.usage_revision THEN
    RAISE EXCEPTION 'Entitlement revisions must be monotonic for one tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entitlement_revision_monotonic BEFORE UPDATE OR DELETE ON entitlement_revisions
FOR EACH ROW EXECUTE FUNCTION entitlement_revision_monotonic();
--> statement-breakpoint
CREATE FUNCTION entitlement_revision_fields(row_data jsonb, field_names text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN field_names IS NULL THEN row_data ELSE
    (SELECT jsonb_object_agg(field_name, row_data -> field_name) FROM unnest(field_names) AS field_name)
  END;
$$;
--> statement-breakpoint
-- Existing operation owners acquire their quota/timeline and resource row locks
-- first. These AFTER STATEMENT triggers take revision rows last, in bytewise
-- tenant-id order across the WHOLE statement, including OLD and NEW tenants.
-- Multi-statement cross-tenant callers must preserve this same tenant order;
-- do not acquire revision rows before an existing quota/timeline lock.
-- Only capacity-relevant UPDATE fields are compared: a device heartbeat/name
-- update must not serialize all factory requests through the tenant revision.
CREATE FUNCTION entitlement_bump_revisions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_tenants text[];
  target_tenant text;
  relevant_fields text[] := CASE WHEN TG_ARGV[2] = '*' THEN NULL ELSE string_to_array(TG_ARGV[2], ',') END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(to_jsonb(r) ->> TG_ARGV[0]) INTO affected_tenants FROM new_rows r;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(to_jsonb(r) ->> TG_ARGV[0]) INTO affected_tenants FROM old_rows r;
  ELSE
    SELECT array_agg(tenant_id) INTO affected_tenants
    FROM (
      SELECT to_jsonb(o) ->> TG_ARGV[0] AS old_tenant, to_jsonb(n) ->> TG_ARGV[0] AS new_tenant
      FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE entitlement_revision_fields(to_jsonb(o), relevant_fields)
        IS DISTINCT FROM entitlement_revision_fields(to_jsonb(n), relevant_fields)
    ) changed
    CROSS JOIN LATERAL (VALUES (changed.old_tenant), (changed.new_tenant)) tenants(tenant_id);
  END IF;
  FOR target_tenant IN SELECT DISTINCT t COLLATE "C" FROM unnest(affected_tenants) t WHERE t IS NOT NULL ORDER BY 1
  LOOP
    -- Auth membership/invitation deletes also fire during organization cascade.
    -- Skip absent parents instead of re-creating a row with a now-invalid FK.
    INSERT INTO entitlement_revisions (tenant_id, revision, usage_revision)
    SELECT id, CASE WHEN TG_ARGV[1] = 'terms' THEN 1 ELSE 0 END,
      CASE WHEN TG_ARGV[1] = 'usage' THEN 1 ELSE 0 END
    FROM organization WHERE id = target_tenant
    ON CONFLICT (tenant_id) DO UPDATE SET
      revision = entitlement_revisions.revision + CASE WHEN TG_ARGV[1] = 'terms' THEN 1 ELSE 0 END,
      usage_revision = entitlement_revisions.usage_revision + CASE WHEN TG_ARGV[1] = 'usage' THEN 1 ELSE 0 END,
      updated_at = clock_timestamp();
  END LOOP;
  RETURN NULL;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON tenant_subscriptions
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON tenant_subscriptions
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON tenant_subscriptions
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON subscription_addons
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON subscription_addons
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON subscription_addons
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON entitlement_sources
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON entitlement_sources
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON entitlement_sources
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'terms', '*');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON lines
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON lines
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON lines
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON station_devices
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,revoked_at,kind,line_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON station_devices
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,revoked_at,kind,line_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON station_devices
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,revoked_at,kind,line_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON kiosks
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,status');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON kiosks
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,status');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON kiosks
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,status');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON member
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('organization_id', 'usage', 'id,organization_id,user_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON member
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('organization_id', 'usage', 'id,organization_id,user_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON member
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('organization_id', 'usage', 'id,organization_id,user_id');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON invitation
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('organization_id', 'usage', 'id,organization_id,status,expires_at');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON invitation
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('organization_id', 'usage', 'id,organization_id,status,expires_at');

--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON invitation
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('organization_id', 'usage', 'id,organization_id,status,expires_at');
