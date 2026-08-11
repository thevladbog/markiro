ALTER TABLE "email_deliveries" DROP CONSTRAINT "email_deliveries_scope_xor";--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "platform_user_id" text;--> statement-breakpoint
ALTER TABLE "platform_two_factors" ADD COLUMN "verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_two_factors" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_deliveries_platform_user_status_idx" ON "email_deliveries" USING btree ("platform_user_id","status");--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_scope_xor" CHECK (num_nonnulls("email_deliveries"."tenant_id", "email_deliveries"."user_id", "email_deliveries"."platform_user_id") = 1);