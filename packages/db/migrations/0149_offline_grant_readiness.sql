CREATE TABLE "device_grant_client_readiness_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_digest" text NOT NULL,
	"client_build" text NOT NULL,
	"storage_revision" integer NOT NULL,
	"reported_mode" text NOT NULL,
	"reported_policy_revision" text,
	"reported_keyset_revision" text,
	"reported_grant_id" uuid,
	"configuration_id" uuid,
	"verified_grant_id" uuid,
	"matches_current_configuration" boolean NOT NULL,
	"verified_grant_matched" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_grant_client_readiness_reports_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "device_grant_client_readiness_owner_check" CHECK (("device_grant_client_readiness_reports"."owner_kind" in ('station','handheld') and "device_grant_client_readiness_reports"."station_device_id" is not null and "device_grant_client_readiness_reports"."kiosk_id" is null) or ("device_grant_client_readiness_reports"."owner_kind"='kiosk' and "device_grant_client_readiness_reports"."kiosk_id" is not null and "device_grant_client_readiness_reports"."station_device_id" is null)),
	CONSTRAINT "device_grant_client_readiness_epoch_check" CHECK ("device_grant_client_readiness_reports"."credential_epoch" > 0),
	CONSTRAINT "device_grant_client_readiness_shape_check" CHECK ("device_grant_client_readiness_reports"."payload_digest" ~ '^[0-9a-f]{64}$' and length("device_grant_client_readiness_reports"."client_build") between 1 and 100 and "device_grant_client_readiness_reports"."storage_revision" > 0 and "device_grant_client_readiness_reports"."reported_mode" in ('observe','strict') and ("device_grant_client_readiness_reports"."reported_policy_revision" is null or length(btrim("device_grant_client_readiness_reports"."reported_policy_revision")) between 1 and 256) and ("device_grant_client_readiness_reports"."reported_keyset_revision" is null or length(btrim("device_grant_client_readiness_reports"."reported_keyset_revision")) between 1 and 256) and (not "device_grant_client_readiness_reports"."matches_current_configuration" or "device_grant_client_readiness_reports"."configuration_id" is not null) and ("device_grant_client_readiness_reports"."verified_grant_matched"=("device_grant_client_readiness_reports"."verified_grant_id" is not null)) and (not "device_grant_client_readiness_reports"."verified_grant_matched" or ("device_grant_client_readiness_reports"."reported_grant_id" is not null and "device_grant_client_readiness_reports"."reported_grant_id"="device_grant_client_readiness_reports"."verified_grant_id")) and isfinite("device_grant_client_readiness_reports"."received_at"))
);
--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD CONSTRAINT "device_grant_configurations_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "device_grant_client_readiness_reports" ADD CONSTRAINT "device_grant_client_readiness_reports_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_client_readiness_reports" ADD CONSTRAINT "device_grant_client_readiness_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_client_readiness_reports" ADD CONSTRAINT "device_grant_client_readiness_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_client_readiness_reports" ADD CONSTRAINT "device_grant_client_readiness_configuration_fk" FOREIGN KEY ("tenant_id","configuration_id") REFERENCES "public"."device_grant_configurations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_client_readiness_reports" ADD CONSTRAINT "device_grant_client_readiness_verified_grant_fk" FOREIGN KEY ("tenant_id","verified_grant_id") REFERENCES "public"."device_grant_issuances"("tenant_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_grant_client_readiness_station_request_uq" ON "device_grant_client_readiness_reports" USING btree ("tenant_id","owner_kind","station_device_id","credential_epoch","request_id") WHERE "device_grant_client_readiness_reports"."station_device_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_grant_client_readiness_kiosk_request_uq" ON "device_grant_client_readiness_reports" USING btree ("tenant_id","owner_kind","kiosk_id","credential_epoch","request_id") WHERE "device_grant_client_readiness_reports"."kiosk_id" is not null;--> statement-breakpoint
CREATE INDEX "device_grant_client_readiness_station_latest_idx" ON "device_grant_client_readiness_reports" USING btree ("tenant_id","owner_kind","station_device_id","credential_epoch","sequence") WHERE "device_grant_client_readiness_reports"."station_device_id" is not null;--> statement-breakpoint
CREATE INDEX "device_grant_client_readiness_kiosk_latest_idx" ON "device_grant_client_readiness_reports" USING btree ("tenant_id","owner_kind","kiosk_id","credential_epoch","sequence") WHERE "device_grant_client_readiness_reports"."kiosk_id" is not null;--> statement-breakpoint
CREATE TRIGGER device_grant_client_readiness_reports_immutable BEFORE UPDATE OR DELETE ON device_grant_client_readiness_reports FOR EACH ROW EXECUTE FUNCTION device_grant_history_immutable();
