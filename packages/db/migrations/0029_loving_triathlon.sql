CREATE TABLE "station_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"station_device_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_pairing_codes_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "station_devices" ALTER COLUMN "api_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "station_devices" ADD COLUMN "line_id" uuid;--> statement-breakpoint
ALTER TABLE "station_devices" ADD COLUMN "paired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "station_devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "station_pairing_codes" ADD CONSTRAINT "station_pairing_codes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_pairing_codes" ADD CONSTRAINT "station_pairing_codes_tenant_station_device_fk" FOREIGN KEY ("tenant_id","station_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_pairing_codes_hash_idx" ON "station_pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "station_pairing_codes_one_live_uq" ON "station_pairing_codes" USING btree ("tenant_id","station_device_id") WHERE used_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "station_pairing_codes_code_hash_live_uq" ON "station_pairing_codes" USING btree ("code_hash") WHERE used_at is null;--> statement-breakpoint
ALTER TABLE "station_devices" ADD CONSTRAINT "station_devices_tenant_line_fk" FOREIGN KEY ("tenant_id","line_id") REFERENCES "public"."lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "kiosks"
SET "device_token_hash" = NULL
WHERE "status" = 'archived' AND "device_token_hash" IS NOT NULL;
