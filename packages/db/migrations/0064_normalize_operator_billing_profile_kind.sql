UPDATE "operator_billing_profiles"
SET "kind" = 'legal_entity'
WHERE "kind" <> 'legal_entity';--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_legal_entity_check" CHECK ("operator_billing_profiles"."kind" = 'legal_entity');
