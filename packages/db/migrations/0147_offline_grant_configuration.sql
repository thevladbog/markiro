CREATE TABLE "device_grant_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"mode" text NOT NULL,
	"policy_id" uuid,
	"policy_revision" text,
	"decision_reference" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_grant_configurations_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "device_grant_configurations_owner_check" CHECK (("device_grant_configurations"."owner_kind" in ('station','handheld') and "device_grant_configurations"."station_device_id" is not null and "device_grant_configurations"."kiosk_id" is null) or ("device_grant_configurations"."owner_kind"='kiosk' and "device_grant_configurations"."kiosk_id" is not null and "device_grant_configurations"."station_device_id" is null)),
	CONSTRAINT "device_grant_configurations_epoch_check" CHECK ("device_grant_configurations"."credential_epoch" > 0),
	CONSTRAINT "device_grant_configurations_mode_check" CHECK ("device_grant_configurations"."mode" in ('observe','strict') and ("device_grant_configurations"."mode" <> 'strict' or "device_grant_configurations"."policy_id" is not null) and (("device_grant_configurations"."policy_id" is null and "device_grant_configurations"."policy_revision" is null and "device_grant_configurations"."decision_reference" is null) or ("device_grant_configurations"."policy_id" is not null and length(btrim("device_grant_configurations"."policy_revision")) > 0 and length(btrim("device_grant_configurations"."decision_reference")) > 0)) is true and isfinite("device_grant_configurations"."issued_at"))
);
--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD CONSTRAINT "device_grant_configurations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD CONSTRAINT "device_grant_configurations_policy_id_entitlement_lifecycle_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD CONSTRAINT "device_grant_configurations_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD CONSTRAINT "device_grant_configurations_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER device_grant_configurations_immutable BEFORE UPDATE OR DELETE ON device_grant_configurations FOR EACH ROW EXECUTE FUNCTION device_grant_history_immutable();
