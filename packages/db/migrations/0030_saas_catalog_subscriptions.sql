CREATE TYPE "public"."platform_role" AS ENUM('platform_admin', 'support', 'accountant');--> statement-breakpoint
CREATE TYPE "public"."catalog_billing_mode" AS ENUM('one_time', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."catalog_billing_period" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."catalog_item_kind" AS ENUM('plan', 'addon', 'service');--> statement-breakpoint
CREATE TYPE "public"."catalog_item_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."catalog_version_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."fulfilment_kind" AS ENUM('subscription', 'subscription_addon', 'ordered_service');--> statement-breakpoint
CREATE TYPE "public"."offer_activation_policy" AS ENUM('immediately', 'after_current');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'published', 'paid', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ordered_service_status" AS ENUM('ordered', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."saas_entitlement_key" AS ENUM('lines', 'stations', 'kiosks', 'cabinetUsers', 'labelEditor', 'publicApi', 'pallets');--> statement-breakpoint
CREATE TYPE "public"."subscription_addon_status" AS ENUM('scheduled', 'active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."subscription_source" AS ENUM('demo', 'manual', 'paid_offer_line');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('pending_activation', 'scheduled', 'trial', 'active', 'expired', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "platform_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "platform_two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "platform_two_factors_user_id_uq" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "platform_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" "platform_role" NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "platform_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addon_entitlements" (
	"catalog_version_id" uuid NOT NULL,
	"catalog_kind" "catalog_item_kind" DEFAULT 'addon' NOT NULL,
	"entitlement_key" "saas_entitlement_key" NOT NULL,
	"quota_increment" integer,
	"feature_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "addon_entitlements_catalog_version_id_entitlement_key_pk" PRIMARY KEY("catalog_version_id","entitlement_key"),
	CONSTRAINT "addon_entitlements_kind_check" CHECK ("addon_entitlements"."catalog_kind" = 'addon'),
	CONSTRAINT "addon_entitlements_effect_shape_check" CHECK (("addon_entitlements"."quota_increment" is not null and "addon_entitlements"."quota_increment" > 0 and "addon_entitlements"."feature_enabled" = false)
        or ("addon_entitlements"."quota_increment" is null and "addon_entitlements"."feature_enabled" = true)),
	CONSTRAINT "addon_entitlements_key_shape_check" CHECK (("addon_entitlements"."entitlement_key" in ('lines', 'stations', 'kiosks', 'cabinetUsers') and "addon_entitlements"."quota_increment" is not null)
        or ("addon_entitlements"."entitlement_key" in ('labelEditor', 'publicApi', 'pallets') and "addon_entitlements"."quota_increment" is null and "addon_entitlements"."feature_enabled" = true))
);
--> statement-breakpoint
CREATE TABLE "catalog_item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"kind" "catalog_item_kind" NOT NULL,
	"version" integer NOT NULL,
	"status" "catalog_version_status" DEFAULT 'draft' NOT NULL,
	"name_ru" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ru" text,
	"description_en" text,
	"unit" text NOT NULL,
	"billing_mode" "catalog_billing_mode" NOT NULL,
	"billing_period" "catalog_billing_period",
	"unit_price" numeric(14, 2) NOT NULL,
	"vat_rate" numeric(5, 2),
	"vat_included" boolean NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_item_versions_item_version_uq" UNIQUE("catalog_item_id","version"),
	CONSTRAINT "catalog_item_versions_id_kind_uq" UNIQUE("id","kind"),
	CONSTRAINT "catalog_item_versions_version_positive" CHECK ("catalog_item_versions"."version" > 0),
	CONSTRAINT "catalog_item_versions_unit_price_nonnegative" CHECK ("catalog_item_versions"."unit_price" >= 0),
	CONSTRAINT "catalog_item_versions_kind_billing_check" CHECK ((
        "catalog_item_versions"."kind" = 'service' and "catalog_item_versions"."billing_mode" = 'one_time' and "catalog_item_versions"."billing_period" is null
      ) or (
        "catalog_item_versions"."kind" in ('plan', 'addon') and "catalog_item_versions"."billing_mode" = 'recurring' and "catalog_item_versions"."billing_period" is not null
      )),
	CONSTRAINT "catalog_item_versions_publication_check" CHECK (("catalog_item_versions"."status" = 'draft' and "catalog_item_versions"."published_at" is null and "catalog_item_versions"."published_by_platform_user_id" is null)
        or ("catalog_item_versions"."status" in ('published', 'retired') and "catalog_item_versions"."published_at" is not null)),
	CONSTRAINT "catalog_item_versions_vat_rate_check" CHECK ("catalog_item_versions"."vat_rate" is null or ("catalog_item_versions"."vat_rate" >= 0 and "catalog_item_versions"."vat_rate" <= 100))
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_ru" text NOT NULL,
	"name_en" text NOT NULL,
	"kind" "catalog_item_kind" NOT NULL,
	"status" "catalog_item_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_code_uq" UNIQUE("code"),
	CONSTRAINT "catalog_items_id_kind_uq" UNIQUE("id","kind")
);
--> statement-breakpoint
CREATE TABLE "commercial_offer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "catalog_item_kind" NOT NULL,
	"catalog_version_id" uuid,
	"name_ru" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ru" text,
	"description_en" text,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"catalog_unit_price" numeric(14, 2),
	"agreed_unit_price" numeric(14, 2) NOT NULL,
	"vat_rate" numeric(5, 2),
	"vat_included" boolean NOT NULL,
	"price_override_reason" text,
	"activation_policy" "offer_activation_policy",
	"line_total" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_offer_lines_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "commercial_offer_lines_offer_position_uq" UNIQUE("offer_id","position"),
	CONSTRAINT "commercial_offer_lines_position_positive" CHECK ("commercial_offer_lines"."position" > 0),
	CONSTRAINT "commercial_offer_lines_quantity_positive" CHECK ("commercial_offer_lines"."quantity" > 0),
	CONSTRAINT "commercial_offer_lines_prices_nonnegative" CHECK ("commercial_offer_lines"."agreed_unit_price" >= 0 and ("commercial_offer_lines"."catalog_unit_price" is null or "commercial_offer_lines"."catalog_unit_price" >= 0) and "commercial_offer_lines"."line_total" >= 0),
	CONSTRAINT "commercial_offer_lines_catalog_service_check" CHECK ("commercial_offer_lines"."kind" = 'service' or "commercial_offer_lines"."catalog_version_id" is not null),
	CONSTRAINT "commercial_offer_lines_activation_policy_check" CHECK (("commercial_offer_lines"."kind" = 'plan' and "commercial_offer_lines"."activation_policy" is not null)
        or ("commercial_offer_lines"."kind" <> 'plan' and "commercial_offer_lines"."activation_policy" is null)),
	CONSTRAINT "commercial_offer_lines_override_reason_check" CHECK ("commercial_offer_lines"."catalog_unit_price" is null
        or "commercial_offer_lines"."agreed_unit_price" = "commercial_offer_lines"."catalog_unit_price"
        or nullif(btrim("commercial_offer_lines"."price_override_reason"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "commercial_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"family_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer NOT NULL,
	"previous_revision_id" uuid,
	"status" "offer_status" DEFAULT 'draft' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"expires_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by_platform_user_id" text,
	"paid_at" timestamp with time zone,
	"created_by_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_offers_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "commercial_offers_tenant_family_revision_uq" UNIQUE("tenant_id","family_id","revision"),
	CONSTRAINT "commercial_offers_revision_positive" CHECK ("commercial_offers"."revision" > 0),
	CONSTRAINT "commercial_offers_total_nonnegative" CHECK ("commercial_offers"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "offer_line_fulfilments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_line_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "fulfilment_kind" NOT NULL,
	"tenant_subscription_id" uuid,
	"subscription_addon_id" uuid,
	"ordered_service_id" uuid,
	"fulfilled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offer_line_fulfilments_offer_line_uq" UNIQUE("tenant_id","offer_line_id"),
	CONSTRAINT "offer_line_fulfilments_target_check" CHECK (("offer_line_fulfilments"."kind" = 'subscription' and "offer_line_fulfilments"."tenant_subscription_id" is not null and "offer_line_fulfilments"."subscription_addon_id" is null and "offer_line_fulfilments"."ordered_service_id" is null)
        or ("offer_line_fulfilments"."kind" = 'subscription_addon' and "offer_line_fulfilments"."tenant_subscription_id" is null and "offer_line_fulfilments"."subscription_addon_id" is not null and "offer_line_fulfilments"."ordered_service_id" is null)
        or ("offer_line_fulfilments"."kind" = 'ordered_service' and "offer_line_fulfilments"."tenant_subscription_id" is null and "offer_line_fulfilments"."subscription_addon_id" is null and "offer_line_fulfilments"."ordered_service_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "ordered_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_line_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"catalog_version_id" uuid,
	"catalog_kind" "catalog_item_kind" DEFAULT 'service' NOT NULL,
	"name_ru" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ru" text,
	"description_en" text,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"status" "ordered_service_status" DEFAULT 'ordered' NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ordered_services_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ordered_services_offer_line_uq" UNIQUE("tenant_id","offer_line_id"),
	CONSTRAINT "ordered_services_kind_check" CHECK ("ordered_services"."catalog_kind" = 'service'),
	CONSTRAINT "ordered_services_quantity_positive" CHECK ("ordered_services"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"bank_reference" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_offer_uq" UNIQUE("tenant_id","offer_id"),
	CONSTRAINT "payments_idempotency_key_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_currency_rub_check" CHECK ("payments"."currency" = 'RUB'),
	CONSTRAINT "payments_bank_reference_check" CHECK (nullif(btrim("payments"."bank_reference"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "plan_entitlements" (
	"catalog_version_id" uuid PRIMARY KEY NOT NULL,
	"catalog_kind" "catalog_item_kind" DEFAULT 'plan' NOT NULL,
	"max_lines" integer,
	"max_stations" integer,
	"max_kiosks" integer,
	"max_cabinet_users" integer,
	"label_editor_enabled" boolean DEFAULT false NOT NULL,
	"public_api_enabled" boolean DEFAULT false NOT NULL,
	"pallets_enabled" boolean DEFAULT false NOT NULL,
	"demo_duration_days" integer,
	CONSTRAINT "plan_entitlements_kind_check" CHECK ("plan_entitlements"."catalog_kind" = 'plan'),
	CONSTRAINT "plan_entitlements_max_lines_positive" CHECK ("plan_entitlements"."max_lines" is null or "plan_entitlements"."max_lines" > 0),
	CONSTRAINT "plan_entitlements_max_stations_positive" CHECK ("plan_entitlements"."max_stations" is null or "plan_entitlements"."max_stations" > 0),
	CONSTRAINT "plan_entitlements_max_kiosks_positive" CHECK ("plan_entitlements"."max_kiosks" is null or "plan_entitlements"."max_kiosks" > 0),
	CONSTRAINT "plan_entitlements_max_cabinet_users_positive" CHECK ("plan_entitlements"."max_cabinet_users" is null or "plan_entitlements"."max_cabinet_users" > 0),
	CONSTRAINT "plan_entitlements_demo_duration_positive" CHECK ("plan_entitlements"."demo_duration_days" is null or "plan_entitlements"."demo_duration_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_platform_user_id" text,
	"actor_role" "platform_role",
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"tenant_id" text,
	"target_type" text NOT NULL,
	"target_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"default_demo_catalog_version_id" uuid NOT NULL,
	"catalog_kind" "catalog_item_kind" DEFAULT 'plan' NOT NULL,
	"updated_by_platform_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_singleton_key_check" CHECK ("platform_settings"."key" = 'default'),
	CONSTRAINT "platform_settings_plan_kind_check" CHECK ("platform_settings"."catalog_kind" = 'plan')
);
--> statement-breakpoint
CREATE TABLE "subscription_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"addon_version_id" uuid NOT NULL,
	"addon_kind" "catalog_item_kind" DEFAULT 'addon' NOT NULL,
	"quantity" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"status" "subscription_addon_status" NOT NULL,
	"source" "subscription_source" NOT NULL,
	"source_offer_line_id" uuid,
	"created_by_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_addons_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_addons_kind_check" CHECK ("subscription_addons"."addon_kind" = 'addon'),
	CONSTRAINT "subscription_addons_quantity_positive" CHECK ("subscription_addons"."quantity" > 0),
	CONSTRAINT "subscription_addons_time_order_check" CHECK ("subscription_addons"."starts_at" is null or "subscription_addons"."ends_at" is null or "subscription_addons"."ends_at" > "subscription_addons"."starts_at"),
	CONSTRAINT "subscription_addons_source_offer_check" CHECK (("subscription_addons"."source" = 'paid_offer_line') = ("subscription_addons"."source_offer_line_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"actor_platform_user_id" text,
	"source" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"plan_kind" "catalog_item_kind" DEFAULT 'plan' NOT NULL,
	"status" "subscription_status" NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"source" "subscription_source" NOT NULL,
	"source_offer_line_id" uuid,
	"created_by_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_subscriptions_plan_kind_check" CHECK ("tenant_subscriptions"."plan_kind" = 'plan'),
	CONSTRAINT "tenant_subscriptions_time_order_check" CHECK ("tenant_subscriptions"."starts_at" is null or "tenant_subscriptions"."ends_at" is null or "tenant_subscriptions"."ends_at" > "tenant_subscriptions"."starts_at"),
	CONSTRAINT "tenant_subscriptions_pending_dates_check" CHECK ("tenant_subscriptions"."status" <> 'pending_activation' or ("tenant_subscriptions"."starts_at" is null and "tenant_subscriptions"."ends_at" is null)),
	CONSTRAINT "tenant_subscriptions_source_offer_check" CHECK (("tenant_subscriptions"."source" = 'paid_offer_line') = ("tenant_subscriptions"."source_offer_line_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_user_id_platform_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_user_id_platform_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_two_factors" ADD CONSTRAINT "platform_two_factors_user_id_platform_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_entitlements" ADD CONSTRAINT "addon_entitlements_addon_version_fk" FOREIGN KEY ("catalog_version_id","catalog_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_published_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("published_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_item_kind_fk" FOREIGN KEY ("catalog_item_id","kind") REFERENCES "public"."catalog_items"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offer_lines" ADD CONSTRAINT "commercial_offer_lines_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offer_lines" ADD CONSTRAINT "commercial_offer_lines_catalog_version_kind_fk" FOREIGN KEY ("catalog_version_id","kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD CONSTRAINT "commercial_offers_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD CONSTRAINT "commercial_offers_published_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("published_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD CONSTRAINT "commercial_offers_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD CONSTRAINT "commercial_offers_tenant_previous_revision_fk" FOREIGN KEY ("tenant_id","previous_revision_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_fulfilments" ADD CONSTRAINT "offer_line_fulfilments_tenant_offer_line_fk" FOREIGN KEY ("tenant_id","offer_line_id") REFERENCES "public"."commercial_offer_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_fulfilments" ADD CONSTRAINT "offer_line_fulfilments_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_fulfilments" ADD CONSTRAINT "offer_line_fulfilments_tenant_subscription_fk" FOREIGN KEY ("tenant_id","tenant_subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_fulfilments" ADD CONSTRAINT "offer_line_fulfilments_tenant_subscription_addon_fk" FOREIGN KEY ("tenant_id","subscription_addon_id") REFERENCES "public"."subscription_addons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_fulfilments" ADD CONSTRAINT "offer_line_fulfilments_tenant_ordered_service_fk" FOREIGN KEY ("tenant_id","ordered_service_id") REFERENCES "public"."ordered_services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD CONSTRAINT "ordered_services_tenant_offer_line_fk" FOREIGN KEY ("tenant_id","offer_line_id") REFERENCES "public"."commercial_offer_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD CONSTRAINT "ordered_services_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD CONSTRAINT "ordered_services_catalog_version_fk" FOREIGN KEY ("catalog_version_id","catalog_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_version_fk" FOREIGN KEY ("catalog_version_id","catalog_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("updated_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_demo_plan_version_fk" FOREIGN KEY ("default_demo_catalog_version_id","catalog_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_tenant_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_addon_version_fk" FOREIGN KEY ("addon_version_id","addon_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_tenant_source_offer_line_fk" FOREIGN KEY ("tenant_id","source_offer_line_id") REFERENCES "public"."commercial_offer_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenant_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_version_fk" FOREIGN KEY ("plan_version_id","plan_kind") REFERENCES "public"."catalog_item_versions"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_source_offer_line_fk" FOREIGN KEY ("tenant_id","source_offer_line_id") REFERENCES "public"."commercial_offer_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_accounts_user_id_idx" ON "platform_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_sessions_user_id_idx" ON "platform_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_verifications_identifier_idx" ON "platform_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "platform_audit_events_created_idx" ON "platform_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "subscription_events_tenant_effective_idx" ON "subscription_events" USING btree ("tenant_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_one_current_uq" ON "tenant_subscriptions" USING btree ("tenant_id") WHERE "tenant_subscriptions"."status" in ('pending_activation', 'trial', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_one_scheduled_uq" ON "tenant_subscriptions" USING btree ("tenant_id") WHERE "tenant_subscriptions"."status" = 'scheduled';
--> statement-breakpoint
CREATE FUNCTION "reject_published_catalog_version_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' AND OLD.status IN ('published', 'retired') THEN
		RAISE EXCEPTION 'published catalog versions are immutable';
	END IF;
	IF OLD.status = 'published' THEN
		IF NEW.status = 'retired'
			AND (to_jsonb(NEW) - ARRAY['status', 'updated_at'])
				IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
			IF EXISTS (
				SELECT 1
				FROM platform_settings
				WHERE default_demo_catalog_version_id = OLD.id
			) THEN
				RAISE EXCEPTION 'the default demo catalog version cannot be retired';
			END IF;
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'published catalog versions are immutable';
	END IF;
	IF OLD.status = 'retired' THEN
		RAISE EXCEPTION 'retired catalog versions are immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_item_versions_immutable_published"
BEFORE UPDATE OR DELETE ON "catalog_item_versions"
FOR EACH ROW EXECUTE FUNCTION "reject_published_catalog_version_mutation"();
--> statement-breakpoint
CREATE FUNCTION "reject_published_catalog_effect_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	version_status catalog_version_status;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT status INTO version_status
		FROM catalog_item_versions
		WHERE id = OLD.catalog_version_id;
		IF version_status IN ('published', 'retired') THEN
			RAISE EXCEPTION 'published catalog entitlement effects are immutable';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT status INTO version_status
		FROM catalog_item_versions
		WHERE id = NEW.catalog_version_id;
		IF version_status IN ('published', 'retired') THEN
			RAISE EXCEPTION 'published catalog entitlement effects are immutable';
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "plan_entitlements_immutable_published"
BEFORE INSERT OR UPDATE OR DELETE ON "plan_entitlements"
FOR EACH ROW EXECUTE FUNCTION "reject_published_catalog_effect_mutation"();
--> statement-breakpoint
CREATE TRIGGER "addon_entitlements_immutable_published"
BEFORE INSERT OR UPDATE OR DELETE ON "addon_entitlements"
FOR EACH ROW EXECUTE FUNCTION "reject_published_catalog_effect_mutation"();
--> statement-breakpoint
CREATE FUNCTION "reject_published_offer_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status <> 'draft' THEN
		IF TG_OP = 'DELETE' THEN
			RAISE EXCEPTION 'published commercial offers are immutable';
		END IF;
		IF (to_jsonb(NEW) - ARRAY['status', 'paid_at', 'updated_at'])
			IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paid_at', 'updated_at']) THEN
			RAISE EXCEPTION 'published commercial offer terms are immutable';
		END IF;
		IF NEW.status NOT IN ('published', 'paid', 'cancelled', 'expired') THEN
			RAISE EXCEPTION 'invalid published commercial offer transition';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "commercial_offers_immutable_published"
BEFORE UPDATE OR DELETE ON "commercial_offers"
FOR EACH ROW EXECUTE FUNCTION "reject_published_offer_mutation"();
--> statement-breakpoint
CREATE FUNCTION "reject_published_offer_line_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_status offer_status;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT status INTO parent_status
		FROM commercial_offers
		WHERE id = OLD.offer_id;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'published commercial offer lines are immutable';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT status INTO parent_status
		FROM commercial_offers
		WHERE id = NEW.offer_id;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'published commercial offer lines are immutable';
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "commercial_offer_lines_immutable_published"
BEFORE INSERT OR UPDATE OR DELETE ON "commercial_offer_lines"
FOR EACH ROW EXECUTE FUNCTION "reject_published_offer_line_mutation"();
--> statement-breakpoint
CREATE FUNCTION "reject_append_only_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payments_append_only"
BEFORE UPDATE OR DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "offer_line_fulfilments_append_only"
BEFORE UPDATE OR DELETE ON "offer_line_fulfilments"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ordered_services_append_only"
BEFORE UPDATE OR DELETE ON "ordered_services"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "subscription_events_append_only"
BEFORE UPDATE OR DELETE ON "subscription_events"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "platform_audit_events_append_only"
BEFORE UPDATE OR DELETE ON "platform_audit_events"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
