ALTER TYPE "public"."subscription_source" ADD VALUE 'paid_invoice_line';--> statement-breakpoint
ALTER TABLE "subscription_addons" DROP CONSTRAINT "subscription_addons_source_offer_check";--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" DROP CONSTRAINT "tenant_subscriptions_source_offer_check";--> statement-breakpoint
ALTER TABLE "ordered_services" ALTER COLUMN "offer_line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ordered_services" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD COLUMN "invoice_line_id" uuid;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD COLUMN "billing_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD COLUMN "source_invoice_line_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN "source_invoice_line_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_source_invoice_line_fk" FOREIGN KEY ("tenant_id","source_invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_tenant_source_invoice_line_fk" FOREIGN KEY ("tenant_id","source_invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ordered_services_invoice_line_uq" ON "ordered_services" USING btree ("tenant_id","invoice_line_id") WHERE "ordered_services"."invoice_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_addons_invoice_line_uq" ON "subscription_addons" USING btree ("tenant_id","source_invoice_line_id") WHERE "subscription_addons"."source_invoice_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_invoice_line_uq" ON "tenant_subscriptions" USING btree ("tenant_id","source_invoice_line_id") WHERE "tenant_subscriptions"."source_invoice_line_id" is not null;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_tenant_invoice_id_uq" UNIQUE("tenant_id","invoice_id","id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_invoice_id_uq" UNIQUE("tenant_id","invoice_id","id");--> statement-breakpoint
ALTER TABLE "ordered_services" ADD CONSTRAINT "ordered_services_tenant_invoice_line_fk" FOREIGN KEY ("tenant_id","invoice_id","invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD CONSTRAINT "ordered_services_tenant_billing_payment_fk" FOREIGN KEY ("tenant_id","invoice_id","billing_payment_id") REFERENCES "public"."billing_payments"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordered_services" ADD CONSTRAINT "ordered_services_source_check" CHECK (("ordered_services"."offer_line_id" is not null and "ordered_services"."payment_id" is not null and "ordered_services"."invoice_id" is null and "ordered_services"."invoice_line_id" is null and "ordered_services"."billing_payment_id" is null)
        or ("ordered_services"."offer_line_id" is null and "ordered_services"."payment_id" is null and "ordered_services"."invoice_id" is not null and "ordered_services"."invoice_line_id" is not null and "ordered_services"."billing_payment_id" is not null));--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_commercial_source_check" CHECK ((("subscription_addons"."source"::text = 'paid_offer_line') = ("subscription_addons"."source_offer_line_id" is not null))
        and (("subscription_addons"."source"::text = 'paid_invoice_line') = ("subscription_addons"."source_invoice_line_id" is not null)));--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_commercial_source_check" CHECK ((("tenant_subscriptions"."source"::text = 'paid_offer_line') = ("tenant_subscriptions"."source_offer_line_id" is not null))
        and (("tenant_subscriptions"."source"::text = 'paid_invoice_line') = ("tenant_subscriptions"."source_invoice_line_id" is not null)));
