ALTER TABLE "operator_billing_profiles" DROP CONSTRAINT "operator_billing_profiles_legal_entity_check";--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "actual_same_as_legal" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "actual_address_raw" text;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "actual_address" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "actual_same_as_legal" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "actual_address_raw" text;--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD COLUMN "actual_address" jsonb;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_actual_same_check" CHECK ("operator_billing_profiles"."actual_same_as_legal" = false or ("operator_billing_profiles"."actual_address_raw" is null and "operator_billing_profiles"."actual_address" is null));--> statement-breakpoint
ALTER TABLE "tenant_billing_profiles" ADD CONSTRAINT "tenant_billing_profiles_actual_same_check" CHECK ("tenant_billing_profiles"."actual_same_as_legal" = false or ("tenant_billing_profiles"."actual_address_raw" is null and "tenant_billing_profiles"."actual_address" is null));