CREATE TYPE "public"."bank_account_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "operator_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"settlement_account" text NOT NULL,
	"bic" text NOT NULL,
	"bank_name" text NOT NULL,
	"correspondent_account" text NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"status" "bank_account_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"archived_by_platform_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"migration_source_profile_id" uuid,
	CONSTRAINT "operator_bank_accounts_identifiers_check" CHECK ("operator_bank_accounts"."settlement_account" ~ '^[0-9]{20}$' and "operator_bank_accounts"."bic" ~ '^[0-9]{9}$' and "operator_bank_accounts"."correspondent_account" ~ '^[0-9]{20}$'),
	CONSTRAINT "operator_bank_accounts_currency_rub_check" CHECK ("operator_bank_accounts"."currency" = 'RUB'),
	CONSTRAINT "operator_bank_accounts_default_active_check" CHECK ("operator_bank_accounts"."is_default" = false or "operator_bank_accounts"."status" = 'active'),
	CONSTRAINT "operator_bank_accounts_archive_check" CHECK (("operator_bank_accounts"."status" = 'active' and "operator_bank_accounts"."archived_by_platform_user_id" is null and "operator_bank_accounts"."archived_at" is null) or ("operator_bank_accounts"."status" = 'archived' and "operator_bank_accounts"."is_default" = false and "operator_bank_accounts"."archived_by_platform_user_id" is not null and "operator_bank_accounts"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tenant_bank_accounts" (
	"tenant_id" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"settlement_account" text NOT NULL,
	"bic" text NOT NULL,
	"bank_name" text NOT NULL,
	"correspondent_account" text NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"status" "bank_account_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_platform_user_id" text NOT NULL,
	"archived_by_platform_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"migration_source_profile_id" uuid,
	CONSTRAINT "tenant_bank_accounts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_bank_accounts_identifiers_check" CHECK ("tenant_bank_accounts"."settlement_account" ~ '^[0-9]{20}$' and "tenant_bank_accounts"."bic" ~ '^[0-9]{9}$' and "tenant_bank_accounts"."correspondent_account" ~ '^[0-9]{20}$'),
	CONSTRAINT "tenant_bank_accounts_currency_rub_check" CHECK ("tenant_bank_accounts"."currency" = 'RUB'),
	CONSTRAINT "tenant_bank_accounts_default_active_check" CHECK ("tenant_bank_accounts"."is_default" = false or "tenant_bank_accounts"."status" = 'active'),
	CONSTRAINT "tenant_bank_accounts_archive_check" CHECK (("tenant_bank_accounts"."status" = 'active' and "tenant_bank_accounts"."archived_by_platform_user_id" is null and "tenant_bank_accounts"."archived_at" is null) or ("tenant_bank_accounts"."status" = 'archived' and "tenant_bank_accounts"."is_default" = false and "tenant_bank_accounts"."archived_by_platform_user_id" is not null and "tenant_bank_accounts"."archived_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "operator_bank_accounts" ADD CONSTRAINT "operator_bank_accounts_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_bank_accounts" ADD CONSTRAINT "operator_bank_accounts_archived_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("archived_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_bank_accounts" ADD CONSTRAINT "operator_bank_accounts_migration_source_profile_id_operator_billing_profiles_id_fk" FOREIGN KEY ("migration_source_profile_id") REFERENCES "public"."operator_billing_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_bank_accounts" ADD CONSTRAINT "tenant_bank_accounts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_bank_accounts" ADD CONSTRAINT "tenant_bank_accounts_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_bank_accounts" ADD CONSTRAINT "tenant_bank_accounts_archived_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("archived_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_bank_accounts" ADD CONSTRAINT "tenant_bank_accounts_profile_fk" FOREIGN KEY ("tenant_id","migration_source_profile_id") REFERENCES "public"."tenant_billing_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_bank_accounts_default_uq" ON "operator_bank_accounts" USING btree ("is_default") WHERE "operator_bank_accounts"."status" = 'active' and "operator_bank_accounts"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_bank_accounts_migration_source_uq" ON "operator_bank_accounts" USING btree ("migration_source_profile_id") WHERE "operator_bank_accounts"."migration_source_profile_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_bank_accounts_default_uq" ON "tenant_bank_accounts" USING btree ("tenant_id") WHERE "tenant_bank_accounts"."status" = 'active' and "tenant_bank_accounts"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_bank_accounts_migration_source_uq" ON "tenant_bank_accounts" USING btree ("tenant_id","migration_source_profile_id") WHERE "tenant_bank_accounts"."migration_source_profile_id" is not null;--> statement-breakpoint
INSERT INTO "operator_bank_accounts" (
	"label",
	"settlement_account",
	"bic",
	"bank_name",
	"correspondent_account",
	"currency",
	"status",
	"is_default",
	"migration_source_profile_id",
	"created_by_platform_user_id"
)
SELECT
	coalesce(nullif(btrim(profile."bank_details" ->> 'label'), ''), 'Основной'),
	profile."bank_details" ->> 'settlementAccount',
	profile."bank_details" ->> 'bic',
	btrim(profile."bank_details" ->> 'bankName'),
	profile."bank_details" ->> 'correspondentAccount',
	'RUB',
	'active',
	true,
	profile."id",
	profile."created_by_platform_user_id"
FROM "operator_billing_profiles" AS profile
WHERE profile."is_current" = true
	AND jsonb_typeof(profile."bank_details") = 'object'
	AND profile."bank_details" ?& ARRAY['settlementAccount', 'bic', 'bankName', 'correspondentAccount']
	AND profile."bank_details" - ARRAY['label', 'settlementAccount', 'bic', 'bankName', 'correspondentAccount'] = '{}'::jsonb
	AND jsonb_typeof(profile."bank_details" -> 'settlementAccount') = 'string'
	AND jsonb_typeof(profile."bank_details" -> 'bic') = 'string'
	AND jsonb_typeof(profile."bank_details" -> 'bankName') = 'string'
	AND jsonb_typeof(profile."bank_details" -> 'correspondentAccount') = 'string'
	AND (NOT profile."bank_details" ? 'label' OR (jsonb_typeof(profile."bank_details" -> 'label') = 'string' AND btrim(profile."bank_details" ->> 'label') <> ''))
	AND profile."bank_details" ->> 'settlementAccount' ~ '^[0-9]{20}$'
	AND profile."bank_details" ->> 'bic' ~ '^[0-9]{9}$'
	AND btrim(profile."bank_details" ->> 'bankName') <> ''
	AND profile."bank_details" ->> 'correspondentAccount' ~ '^[0-9]{20}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "tenant_bank_accounts" (
	"tenant_id",
	"label",
	"settlement_account",
	"bic",
	"bank_name",
	"correspondent_account",
	"currency",
	"status",
	"is_default",
	"migration_source_profile_id",
	"created_by_platform_user_id"
)
SELECT
	profile."tenant_id",
	coalesce(nullif(btrim(profile."bank_details" ->> 'label'), ''), 'Основной'),
	profile."bank_details" ->> 'settlementAccount',
	profile."bank_details" ->> 'bic',
	btrim(profile."bank_details" ->> 'bankName'),
	profile."bank_details" ->> 'correspondentAccount',
	'RUB',
	'active',
	true,
	profile."id",
	profile."created_by_platform_user_id"
FROM "tenant_billing_profiles" AS profile
WHERE profile."is_current" = true
	AND profile."created_by_platform_user_id" IS NOT NULL
	AND jsonb_typeof(profile."bank_details") = 'object'
	AND profile."bank_details" ?& ARRAY['settlementAccount', 'bic', 'bankName', 'correspondentAccount']
	AND profile."bank_details" - ARRAY['label', 'settlementAccount', 'bic', 'bankName', 'correspondentAccount'] = '{}'::jsonb
	AND jsonb_typeof(profile."bank_details" -> 'settlementAccount') = 'string'
	AND jsonb_typeof(profile."bank_details" -> 'bic') = 'string'
	AND jsonb_typeof(profile."bank_details" -> 'bankName') = 'string'
	AND jsonb_typeof(profile."bank_details" -> 'correspondentAccount') = 'string'
	AND (NOT profile."bank_details" ? 'label' OR (jsonb_typeof(profile."bank_details" -> 'label') = 'string' AND btrim(profile."bank_details" ->> 'label') <> ''))
	AND profile."bank_details" ->> 'settlementAccount' ~ '^[0-9]{20}$'
	AND profile."bank_details" ->> 'bic' ~ '^[0-9]{9}$'
	AND btrim(profile."bank_details" ->> 'bankName') <> ''
	AND profile."bank_details" ->> 'correspondentAccount' ~ '^[0-9]{20}$'
ON CONFLICT DO NOTHING;
