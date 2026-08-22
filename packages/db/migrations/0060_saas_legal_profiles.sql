ALTER TABLE "operator_billing_profiles" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "legal_address_raw" text;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "legal_address" jsonb;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "postal_same_as_legal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "postal_address_raw" text;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "postal_address" jsonb;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "is_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "confirmed_by_platform_user_id" text;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "legal_address_raw" text;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "legal_address" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "postal_same_as_legal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "postal_address_raw" text;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "postal_address" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "is_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "confirmed_by_platform_user_id" text;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "operator_billing_profiles"
SET "full_name" = "display_name",
    "legal_address_raw" = "address_raw",
    "legal_address" = CASE
      WHEN "address" IS NULL THEN NULL
      WHEN jsonb_typeof("address") = 'object'
        THEN "address" || jsonb_build_object('value', "address_raw")
      ELSE jsonb_build_object('value', "address_raw")
    END;--> statement-breakpoint
UPDATE "tenant_billing_profiles"
SET "full_name" = "display_name",
    "legal_address_raw" = "address_raw",
    "legal_address" = CASE
      WHEN "address" IS NULL THEN NULL
      WHEN jsonb_typeof("address") = 'object'
        THEN "address" || jsonb_build_object('value', "address_raw")
      ELSE jsonb_build_object('value', "address_raw")
    END;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ALTER COLUMN "full_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ALTER COLUMN "legal_address_raw" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ALTER COLUMN "full_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ALTER COLUMN "legal_address_raw" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_confirmed_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("confirmed_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD CONSTRAINT "tenant_billing_profiles_confirmed_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("confirmed_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_confirmation_check" CHECK (("operator_billing_profiles"."is_confirmed" = false and "operator_billing_profiles"."confirmed_by_platform_user_id" is null and "operator_billing_profiles"."confirmed_at" is null) or ("operator_billing_profiles"."is_confirmed" = true and "operator_billing_profiles"."confirmed_by_platform_user_id" is not null and "operator_billing_profiles"."confirmed_at" is not null));--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_postal_same_check" CHECK ("operator_billing_profiles"."postal_same_as_legal" = false or ("operator_billing_profiles"."postal_address_raw" is null and "operator_billing_profiles"."postal_address" is null));--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD CONSTRAINT "tenant_billing_profiles_confirmation_check" CHECK (("tenant_billing_profiles"."is_confirmed" = false and "tenant_billing_profiles"."confirmed_by_platform_user_id" is null and "tenant_billing_profiles"."confirmed_at" is null) or ("tenant_billing_profiles"."is_confirmed" = true and "tenant_billing_profiles"."confirmed_by_platform_user_id" is not null and "tenant_billing_profiles"."confirmed_at" is not null));--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD CONSTRAINT "tenant_billing_profiles_postal_same_check" CHECK ("tenant_billing_profiles"."postal_same_as_legal" = false or ("tenant_billing_profiles"."postal_address_raw" is null and "tenant_billing_profiles"."postal_address" is null));
