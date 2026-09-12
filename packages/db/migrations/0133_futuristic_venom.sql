CREATE TABLE "working_device_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"provenance" text NOT NULL,
	"last_event_id" uuid,
	CONSTRAINT "working_device_assignments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_device_assignments_tenant_device_uq" UNIQUE("tenant_id","device_id"),
	CONSTRAINT "working_device_assignments_state_check" CHECK ("working_device_assignments"."state" in ('reserved','assigned','released') and "working_device_assignments"."revision" >= 1 and "working_device_assignments"."provenance" in ('migration','runtime')),
	CONSTRAINT "working_device_assignments_release_check" CHECK (("working_device_assignments"."state" <> 'released' and "working_device_assignments"."released_at" is null and "working_device_assignments"."release_reason" is null) or ("working_device_assignments"."state" = 'released' and "working_device_assignments"."released_at" is not null and "working_device_assignments"."release_reason" is not null and "working_device_assignments"."release_reason" in ('reservation_cancelled','security_revoked')))
);
--> statement-breakpoint
CREATE TABLE "working_device_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"outcome" text DEFAULT 'success' NOT NULL,
	"request_id" uuid,
	"request_hash" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_device_events_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_device_events_tenant_device_id_uq" UNIQUE("tenant_id","device_id","id"),
	CONSTRAINT "working_device_events_tenant_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "working_device_events_actor_check" CHECK ("working_device_events"."actor_domain" in ('migration','system','cabinet','platform','device') and ("working_device_events"."actor_domain" <> 'migration' or "working_device_events"."actor_id" is null)),
	CONSTRAINT "working_device_events_action_check" CHECK ("working_device_events"."action" in ('observed','reserved','assigned','released','reservation_cancelled') and "working_device_events"."outcome" = 'success'),
	CONSTRAINT "working_device_events_json_check" CHECK (("working_device_events"."before" is null or jsonb_typeof("working_device_events"."before")='object') and jsonb_typeof("working_device_events"."after")='object')
);
--> statement-breakpoint
ALTER TABLE "working_device_assignments" ADD CONSTRAINT "working_device_assignments_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_assignments" ADD CONSTRAINT "working_device_assignments_last_event_fk" FOREIGN KEY ("tenant_id","device_id","last_event_id") REFERENCES "public"."working_device_events"("tenant_id","device_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_events" ADD CONSTRAINT "working_device_events_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Observation time is migration time, never a fabricated purchase or assignment date.
WITH observed AS (
  SELECT gen_random_uuid() AS id, tenant_id, id AS device_id,
    CASE WHEN revoked_at IS NOT NULL THEN 'released'
         WHEN paired_at IS NOT NULL OR api_key_id IS NOT NULL THEN 'assigned'
         ELSE 'reserved' END AS state,
    CASE WHEN revoked_at IS NOT NULL THEN 'security_revoked' END AS release_reason,
    gen_random_uuid() AS event_id
  FROM station_devices
), events AS (
  INSERT INTO working_device_events (id,tenant_id,device_id,actor_domain,action,"after")
  SELECT event_id,tenant_id,device_id,'migration','observed',
    jsonb_build_object('assignmentId',id,'state',state,'revision',1,'releaseReason',release_reason,
      'releasedAt',CASE WHEN state='released' THEN now() END,'provenance','migration')
  FROM observed
  RETURNING id
)
INSERT INTO working_device_assignments
  (id,tenant_id,device_id,state,revision,released_at,release_reason,provenance,last_event_id)
SELECT o.id,o.tenant_id,o.device_id,o.state,1,
  CASE WHEN o.state='released' THEN now() END,o.release_reason,'migration',o.event_id
FROM observed o JOIN events e ON e.id=o.event_id;
--> statement-breakpoint
CREATE FUNCTION working_device_guard_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only actual parent removal may cascade cleanup; a caller cannot delete history directly.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM station_devices WHERE tenant_id=OLD.tenant_id AND id=OLD.device_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Working device history is immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_events_immutable
BEFORE UPDATE OR DELETE ON working_device_events
FOR EACH ROW EXECUTE FUNCTION working_device_guard_history();
--> statement-breakpoint
CREATE FUNCTION working_device_guard_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM station_devices WHERE tenant_id=OLD.tenant_id AND id=OLD.device_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Working device assignment must be retained' USING ERRCODE='23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    RAISE EXCEPTION 'Working device assignment identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.release_reason = 'reservation_cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Cancelled reservation is terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_assignments_retained
BEFORE UPDATE OR DELETE ON working_device_assignments
FOR EACH ROW EXECUTE FUNCTION working_device_guard_assignment();
--> statement-breakpoint
-- Install after observation so backfill does not imply a business usage change.
CREATE TRIGGER entitlement_revision_insert AFTER INSERT ON working_device_assignments
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,device_id,state,revision,release_reason');
--> statement-breakpoint
CREATE TRIGGER entitlement_revision_update AFTER UPDATE ON working_device_assignments
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,device_id,state,revision,release_reason');
--> statement-breakpoint
CREATE TRIGGER entitlement_revision_delete AFTER DELETE ON working_device_assignments
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION entitlement_bump_revisions('tenant_id', 'usage', 'id,tenant_id,device_id,state,revision,release_reason');
