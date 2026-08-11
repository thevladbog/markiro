CREATE TABLE "kiosk_order_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kiosk_id" uuid NOT NULL,
	"device_seq" integer NOT NULL,
	"subscription_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_order_admissions_tenant_sequence_uq" UNIQUE("tenant_id","kiosk_id","device_seq"),
	CONSTRAINT "kiosk_order_admissions_device_seq_check" CHECK ("kiosk_order_admissions"."device_seq" >= 0),
	CONSTRAINT "kiosk_order_admissions_token_hash_check" CHECK ("kiosk_order_admissions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "kiosk_order_admissions_payload_digest_check" CHECK ("kiosk_order_admissions"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "kiosk_order_admissions_time_order_check" CHECK ("kiosk_order_admissions"."claimed_at" < "kiosk_order_admissions"."not_after")
);
--> statement-breakpoint
ALTER TABLE "kiosk_order_admissions" ADD CONSTRAINT "kiosk_order_admissions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_order_admissions" ADD CONSTRAINT "kiosk_order_admissions_tenant_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_order_admissions" ADD CONSTRAINT "kiosk_order_admissions_tenant_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_order_admissions_token_hash_uq" ON "kiosk_order_admissions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "kiosk_order_admissions_tenant_expiry_idx" ON "kiosk_order_admissions" USING btree ("tenant_id","not_after");