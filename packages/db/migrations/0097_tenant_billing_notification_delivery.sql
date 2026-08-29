CREATE UNIQUE INDEX "email_deliveries_tenant_billing_recipient_uq"
ON "email_deliveries" USING btree ("tenant_id", "kind", "source_id", "recipient")
WHERE "kind" = 'tenant-billing-notification' AND "tenant_id" IS NOT NULL AND "source_id" IS NOT NULL;
