CREATE TABLE "working_device_replacement_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"observation" jsonb NOT NULL,
	"facts_fingerprint" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_actor_domain" text,
	"cancelled_actor_id" text,
	CONSTRAINT "working_device_replacement_preparations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_device_replacement_preparations_tenant_device_id_uq" UNIQUE("tenant_id","device_id","id"),
	CONSTRAINT "working_device_replacement_preparations_tenant_preview_uq" UNIQUE("tenant_id","device_id","preview_id"),
	CONSTRAINT "working_device_replacement_preparations_identity_check" CHECK ("working_device_replacement_preparations"."state" in ('prepared','cancelled') and "working_device_replacement_preparations"."revision" >= 1 and "working_device_replacement_preparations"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_replacement_preparations"."actor_id")) between 1 and 256 and jsonb_typeof("working_device_replacement_preparations"."observation") = 'object' and "working_device_replacement_preparations"."facts_fingerprint" ~ '^[0-9a-f]{64}$' and isfinite("working_device_replacement_preparations"."prepared_at")),
	CONSTRAINT "working_device_replacement_preparations_cancellation_check" CHECK ((("working_device_replacement_preparations"."state" = 'prepared' and "working_device_replacement_preparations"."cancelled_at" is null and "working_device_replacement_preparations"."cancelled_actor_domain" is null and "working_device_replacement_preparations"."cancelled_actor_id" is null) or ("working_device_replacement_preparations"."state" = 'cancelled' and "working_device_replacement_preparations"."cancelled_at" is not null and isfinite("working_device_replacement_preparations"."cancelled_at") and "working_device_replacement_preparations"."cancelled_at" >= "working_device_replacement_preparations"."prepared_at" and "working_device_replacement_preparations"."cancelled_actor_domain" is not null and "working_device_replacement_preparations"."cancelled_actor_domain" in ('cabinet','platform') and "working_device_replacement_preparations"."cancelled_actor_id" is not null and length(btrim("working_device_replacement_preparations"."cancelled_actor_id")) between 1 and 256)) is true)
);
--> statement-breakpoint
CREATE TABLE "working_device_replacement_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"facts_fingerprint" text NOT NULL,
	"observation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"result_preparation_id" uuid,
	"response" jsonb,
	CONSTRAINT "working_device_replacement_previews_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_device_replacement_previews_tenant_device_id_uq" UNIQUE("tenant_id","device_id","id"),
	CONSTRAINT "working_device_replacement_previews_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "working_device_replacement_previews_actor_check" CHECK ("working_device_replacement_previews"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_replacement_previews"."actor_id")) between 1 and 256),
	CONSTRAINT "working_device_replacement_previews_payload_check" CHECK (jsonb_typeof("working_device_replacement_previews"."payload") = 'object' and jsonb_typeof("working_device_replacement_previews"."observation") = 'object' and "working_device_replacement_previews"."payload_hash" ~ '^[0-9a-f]{64}$' and "working_device_replacement_previews"."facts_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "working_device_replacement_previews_interval_check" CHECK (isfinite("working_device_replacement_previews"."created_at") and isfinite("working_device_replacement_previews"."expires_at") and "working_device_replacement_previews"."expires_at" > "working_device_replacement_previews"."created_at" and "working_device_replacement_previews"."expires_at" <= "working_device_replacement_previews"."created_at" + interval '5 minutes'),
	CONSTRAINT "working_device_replacement_previews_result_check" CHECK (("working_device_replacement_previews"."confirmed_at" is null and "working_device_replacement_previews"."result_preparation_id" is null and "working_device_replacement_previews"."response" is null) or ("working_device_replacement_previews"."confirmed_at" is not null and "working_device_replacement_previews"."result_preparation_id" is not null and "working_device_replacement_previews"."response" is not null and isfinite("working_device_replacement_previews"."confirmed_at") and "working_device_replacement_previews"."confirmed_at" >= "working_device_replacement_previews"."created_at" and "working_device_replacement_previews"."confirmed_at" < "working_device_replacement_previews"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "working_device_events" DROP CONSTRAINT "working_device_events_action_check";--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" ADD CONSTRAINT "working_device_replacement_preparations_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" ADD CONSTRAINT "working_device_replacement_preparations_tenant_device_preview_fk" FOREIGN KEY ("tenant_id","device_id","preview_id") REFERENCES "public"."working_device_replacement_previews"("tenant_id","device_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_previews" ADD CONSTRAINT "working_device_replacement_previews_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "working_device_replacements_one_prepared_uq" ON "working_device_replacement_preparations" USING btree ("tenant_id","device_id") WHERE "working_device_replacement_preparations"."state" = 'prepared';--> statement-breakpoint
ALTER TABLE "working_device_events" ADD CONSTRAINT "working_device_events_replacement_check" CHECK ("working_device_events"."action" not in ('replacement_prepared','replacement_cancelled') or (("working_device_events"."actor_domain" in ('cabinet','platform') and "working_device_events"."actor_id" is not null and "working_device_events"."request_id" is not null and "working_device_events"."request_hash" is not null and "working_device_events"."request_hash" ~ '^[0-9a-f]{64}$' and "working_device_events"."response" is not null and jsonb_typeof("working_device_events"."response") = 'object' and "working_device_events"."response"->>'requestId' is not null and "working_device_events"."response"->>'requestId' = "working_device_events"."request_id"::text and "working_device_events"."after"->>'id' is not null and "working_device_events"."response"#>>'{preparation,id}' is not null and "working_device_events"."response"#>>'{preparation,id}' = "working_device_events"."after"->>'id' and (("working_device_events"."action" = 'replacement_prepared' and "working_device_events"."before" is null and "working_device_events"."after"->>'state' = 'prepared' and "working_device_events"."response"#>>'{preparation,state}' = 'prepared') or ("working_device_events"."action" = 'replacement_cancelled' and "working_device_events"."before" is not null and "working_device_events"."before"->>'state' = 'prepared' and "working_device_events"."after"->>'state' = 'cancelled' and "working_device_events"."response"#>>'{preparation,state}' = 'cancelled'))) is true));--> statement-breakpoint
ALTER TABLE "working_device_events" ADD CONSTRAINT "working_device_events_action_check" CHECK ("working_device_events"."action" in ('observed','reserved','assigned','released','reservation_cancelled','replacement_prepared','replacement_cancelled') and "working_device_events"."outcome" = 'success');
--> statement-breakpoint
CREATE FUNCTION working_device_replacement_guard_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Working device replacement preview is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.confirmed_at IS NOT NULL
    OR NEW.confirmed_at IS NULL
    OR jsonb_typeof(NEW.response) IS DISTINCT FROM 'object'
    OR NEW.response->>'requestId' IS DISTINCT FROM NEW.request_id::text
    OR NEW.response#>>'{preparation,id}' IS DISTINCT FROM NEW.result_preparation_id::text
    OR NEW.response#>>'{preparation,state}' IS DISTINCT FROM 'prepared'
    OR (to_jsonb(NEW) - ARRAY['confirmed_at','result_preparation_id','response'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['confirmed_at','result_preparation_id','response'])
    OR NOT EXISTS (
      SELECT 1 FROM working_device_replacement_preparations p
      WHERE p.tenant_id=NEW.tenant_id AND p.device_id=NEW.device_id
        AND p.id=NEW.result_preparation_id AND p.preview_id=NEW.id AND p.state='prepared'
    ) THEN
    RAISE EXCEPTION 'Working device replacement preview is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_replacement_previews_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_previews
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_preview();
--> statement-breakpoint
CREATE FUNCTION working_device_replacement_guard_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR OLD.state <> 'prepared'
    OR NEW.state <> 'cancelled'
    OR NEW.revision <> OLD.revision + 1
    OR (to_jsonb(NEW) - ARRAY['revision','state','cancelled_at','cancelled_actor_domain','cancelled_actor_id'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','state','cancelled_at','cancelled_actor_domain','cancelled_actor_id']) THEN
    RAISE EXCEPTION 'Working device replacement preparation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_replacement_preparations_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_preparations
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_preparation();
