CREATE TABLE "working_device_replacement_execution_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"mode" text NOT NULL,
	"emergency_reason" text,
	"facts_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"new_work_allowed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "replacement_execution_previews_request_uq" UNIQUE("tenant_id","actor_domain","request_id"),
	CONSTRAINT "replacement_execution_previews_identity_check" CHECK ("working_device_replacement_execution_previews"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_replacement_execution_previews"."actor_id")) between 1 and 256 and "working_device_replacement_execution_previews"."expected_revision" > 0 and "working_device_replacement_execution_previews"."request_hash" ~ '^[0-9a-f]{64}$' and "working_device_replacement_execution_previews"."facts_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "replacement_execution_previews_mode_check" CHECK ((("working_device_replacement_execution_previews"."mode" = 'normal' and "working_device_replacement_execution_previews"."emergency_reason" is null) or ("working_device_replacement_execution_previews"."mode" = 'emergency' and "working_device_replacement_execution_previews"."emergency_reason" is not null and length(btrim("working_device_replacement_execution_previews"."emergency_reason")) between 1 and 1000)) is true),
	CONSTRAINT "replacement_execution_previews_interval_check" CHECK (isfinite("working_device_replacement_execution_previews"."created_at") and isfinite("working_device_replacement_execution_previews"."expires_at") and isfinite("working_device_replacement_execution_previews"."new_work_allowed_at") and "working_device_replacement_execution_previews"."expires_at" > "working_device_replacement_execution_previews"."created_at" and "working_device_replacement_execution_previews"."expires_at" <= "working_device_replacement_execution_previews"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
ALTER TABLE "working_device_replacement_execution_previews" ADD CONSTRAINT "replacement_execution_previews_preparation_fk" FOREIGN KEY ("tenant_id","device_id","preparation_id") REFERENCES "public"."working_device_replacement_preparations"("tenant_id","device_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER replacement_execution_previews_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_execution_previews
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_report();
