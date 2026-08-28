ALTER TABLE "tenant_billing_request_attachments" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
UPDATE "tenant_billing_request_attachments"
SET "idempotency_key" = "id"
WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ADD CONSTRAINT "tenant_billing_request_attachments_tenant_request_idempotency_uq" UNIQUE("tenant_id","request_id","idempotency_key");
