CREATE TABLE "working_device_replacement_capabilities" (
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"credential_epoch" integer NOT NULL,
	"supported" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "working_device_replacement_capabilities_tenant_id_device_id_credential_epoch_pk" PRIMARY KEY("tenant_id","device_id","credential_epoch"),
	CONSTRAINT "replacement_capabilities_epoch_check" CHECK ("working_device_replacement_capabilities"."credential_epoch" > 0),
	CONSTRAINT "replacement_capabilities_interval_check" CHECK (isfinite("working_device_replacement_capabilities"."observed_at") and isfinite("working_device_replacement_capabilities"."expires_at") and "working_device_replacement_capabilities"."expires_at" > "working_device_replacement_capabilities"."observed_at" and "working_device_replacement_capabilities"."expires_at" <= "working_device_replacement_capabilities"."observed_at" + interval '5 minutes')
);
--> statement-breakpoint
ALTER TABLE "working_device_replacement_capabilities" ADD CONSTRAINT "replacement_capabilities_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;