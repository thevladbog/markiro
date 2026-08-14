ALTER TABLE "email_deliveries" DROP CONSTRAINT "email_deliveries_scope_xor";--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "public_request_id" uuid;--> statement-breakpoint
CREATE INDEX "email_deliveries_public_request_status_idx" ON "email_deliveries" USING btree ("public_request_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_public_request_kind_uq" ON "email_deliveries" USING btree ("public_request_id","kind") WHERE "email_deliveries"."public_request_id" is not null;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_scope_xor" CHECK (num_nonnulls("email_deliveries"."tenant_id", "email_deliveries"."user_id", "email_deliveries"."platform_user_id", "email_deliveries"."public_request_id") = 1);