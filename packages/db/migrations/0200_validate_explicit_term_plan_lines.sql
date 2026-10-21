-- Runtime migration commits 0199 before validating existing rows.
ALTER TABLE "commercial_offer_lines" VALIDATE CONSTRAINT "commercial_offer_lines_commercial_terms_check";--> statement-breakpoint
ALTER TABLE "subscription_addons" VALIDATE CONSTRAINT "subscription_addons_commercial_period_check";--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" VALIDATE CONSTRAINT "tenant_subscriptions_commercial_period_check";--> statement-breakpoint
ALTER TABLE "invoice_lines" VALIDATE CONSTRAINT "invoice_lines_commercial_terms_check";
