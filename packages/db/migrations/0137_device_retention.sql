CREATE TABLE "working_device_retention_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"selection_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_device_retention_events_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "working_device_retention_events_actor_check" CHECK ("working_device_retention_events"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_retention_events"."actor_id")) between 1 and 256 and "working_device_retention_events"."action" = 'selection_confirmed' and isfinite("working_device_retention_events"."created_at")),
	CONSTRAINT "working_device_retention_events_result_check" CHECK ((jsonb_typeof("working_device_retention_events"."after") = 'object' and ("working_device_retention_events"."before" is null or jsonb_typeof("working_device_retention_events"."before") = 'object') and "working_device_retention_events"."after"->>'id' = "working_device_retention_events"."selection_id"::text and jsonb_typeof("working_device_retention_events"."after"->'revision') = 'number' and "working_device_retention_events"."after"->>'revision' ~ '^[1-9][0-9]*$' and jsonb_typeof("working_device_retention_events"."result") = 'object' and "working_device_retention_events"."result"->>'requestId' = "working_device_retention_events"."request_id"::text and "working_device_retention_events"."result"->'selection' = "working_device_retention_events"."after" and (("working_device_retention_events"."before" is null and "working_device_retention_events"."after"->>'revision' = '1') or (jsonb_typeof("working_device_retention_events"."before") = 'object' and "working_device_retention_events"."before"->>'id' = "working_device_retention_events"."selection_id"::text and jsonb_typeof("working_device_retention_events"."before"->'revision') = 'number' and "working_device_retention_events"."before"->>'revision' ~ '^[1-9][0-9]*$' and ("working_device_retention_events"."after"->>'revision')::numeric = ("working_device_retention_events"."before"->>'revision')::numeric + 1))) is true)
);
--> statement-breakpoint
CREATE TABLE "working_device_retention_members" (
	"tenant_id" text NOT NULL,
	"selection_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	CONSTRAINT "working_device_retention_members_selection_device_uq" UNIQUE("selection_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "working_device_retention_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"facts_fingerprint" text NOT NULL,
	"observation" jsonb NOT NULL,
	"expected_revision" integer NOT NULL,
	"selected_device_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"result_selection_id" uuid,
	"response" jsonb,
	CONSTRAINT "working_device_retention_previews_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_device_retention_previews_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "working_device_retention_previews_actor_check" CHECK ("working_device_retention_previews"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_retention_previews"."actor_id")) between 1 and 256),
	CONSTRAINT "working_device_retention_previews_payload_check" CHECK (jsonb_typeof("working_device_retention_previews"."payload") = 'object' and jsonb_typeof("working_device_retention_previews"."observation") = 'object' and "working_device_retention_previews"."payload_hash" ~ '^[0-9a-f]{64}$' and "working_device_retention_previews"."facts_fingerprint" ~ '^[0-9a-f]{64}$' and "working_device_retention_previews"."expected_revision" >= 0 and jsonb_typeof("working_device_retention_previews"."selected_device_ids") = 'array'),
	CONSTRAINT "working_device_retention_previews_interval_check" CHECK (isfinite("working_device_retention_previews"."created_at") and isfinite("working_device_retention_previews"."expires_at") and "working_device_retention_previews"."expires_at" > "working_device_retention_previews"."created_at" and "working_device_retention_previews"."expires_at" <= "working_device_retention_previews"."created_at" + interval '5 minutes'),
	CONSTRAINT "working_device_retention_previews_result_check" CHECK ((("working_device_retention_previews"."confirmed_at" is null and "working_device_retention_previews"."result_selection_id" is null and "working_device_retention_previews"."response" is null) or ("working_device_retention_previews"."confirmed_at" is not null and "working_device_retention_previews"."result_selection_id" is not null and "working_device_retention_previews"."response" is not null and isfinite("working_device_retention_previews"."confirmed_at") and "working_device_retention_previews"."confirmed_at" >= "working_device_retention_previews"."created_at" and "working_device_retention_previews"."confirmed_at" < "working_device_retention_previews"."expires_at" and jsonb_typeof("working_device_retention_previews"."response") = 'object' and "working_device_retention_previews"."response"->>'requestId' = "working_device_retention_previews"."request_id"::text and "working_device_retention_previews"."response"#>>'{selection,id}' = "working_device_retention_previews"."result_selection_id"::text and jsonb_typeof("working_device_retention_previews"."response"#>'{selection,revision}') = 'number' and "working_device_retention_previews"."response"#>>'{selection,revision}' ~ '^[1-9][0-9]*$')) is true)
);
--> statement-breakpoint
CREATE TABLE "working_device_retention_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"preview_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"observation" jsonb NOT NULL,
	"facts_fingerprint" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_device_retention_selections_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_device_retention_selections_tenant_boundary_uq" UNIQUE("tenant_id","effective_at"),
	CONSTRAINT "working_device_retention_selections_identity_check" CHECK ("working_device_retention_selections"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_retention_selections"."actor_id")) between 1 and 256 and "working_device_retention_selections"."revision" >= 1 and jsonb_typeof("working_device_retention_selections"."observation") = 'object' and "working_device_retention_selections"."facts_fingerprint" ~ '^[0-9a-f]{64}$' and isfinite("working_device_retention_selections"."prepared_at") and isfinite("working_device_retention_selections"."effective_at") and "working_device_retention_selections"."prepared_at" < "working_device_retention_selections"."effective_at")
);
--> statement-breakpoint
ALTER TABLE "working_device_retention_events" ADD CONSTRAINT "working_device_retention_events_tenant_selection_fk" FOREIGN KEY ("tenant_id","selection_id") REFERENCES "public"."working_device_retention_selections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_retention_members" ADD CONSTRAINT "working_device_retention_members_tenant_selection_fk" FOREIGN KEY ("tenant_id","selection_id") REFERENCES "public"."working_device_retention_selections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_retention_members" ADD CONSTRAINT "working_device_retention_members_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_retention_previews" ADD CONSTRAINT "working_device_retention_previews_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_retention_selections" ADD CONSTRAINT "working_device_retention_selections_tenant_preview_fk" FOREIGN KEY ("tenant_id","preview_id") REFERENCES "public"."working_device_retention_previews"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Retention receipts and events are immutable; the current selection and its
-- membership remain revision-controlled by the transactional service.
CREATE FUNCTION working_device_retention_guard_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Working device retention history is immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_retention_events_immutable
BEFORE UPDATE OR DELETE ON working_device_retention_events
FOR EACH ROW EXECUTE FUNCTION working_device_retention_guard_event();
--> statement-breakpoint
CREATE FUNCTION working_device_retention_guard_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Working device retention preview is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.confirmed_at IS NOT NULL OR NEW.confirmed_at IS NULL
    OR (to_jsonb(NEW) - ARRAY['confirmed_at','result_selection_id','response'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['confirmed_at','result_selection_id','response'])
  ) THEN
    RAISE EXCEPTION 'Working device retention preview is immutable' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.selected_device_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid retention membership' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.selected_device_ids) AS d(value)
    WHERE jsonb_typeof(value) <> 'string'
      OR value #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements(NEW.selected_device_ids) AS d(value)) THEN
    RAISE EXCEPTION 'Invalid retention membership' USING ERRCODE='23514';
  END IF;
  IF NEW.confirmed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM working_device_retention_selections s
    WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.result_selection_id
      AND s.preview_id=NEW.id AND s.revision=NEW.expected_revision+1
      AND s.actor_domain=NEW.actor_domain AND s.actor_id=NEW.actor_id
      AND s.observation=NEW.observation AND s.facts_fingerprint=NEW.facts_fingerprint
      AND NEW.response#>>'{selection,revision}'=s.revision::text
  ) THEN
    RAISE EXCEPTION 'Retention result does not match its preview' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_retention_previews_immutable
BEFORE INSERT OR UPDATE OR DELETE ON working_device_retention_previews
FOR EACH ROW EXECUTE FUNCTION working_device_retention_guard_preview();
