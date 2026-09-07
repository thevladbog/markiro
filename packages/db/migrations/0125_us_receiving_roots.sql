-- Root-only compatibility slice. Revision-1 lifecycle and v1/v2 snapshot rules
-- stay closed and unchanged until the lifecycle transition migration.
LOCK TABLE traceability_events, receiving_event_items, receiving_event_documents,
  receiving_operations IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "receiving_event_roots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_number" text NOT NULL,
	"lifecycle_version" integer DEFAULT 1 NOT NULL,
	"next_revision" integer DEFAULT 2 NOT NULL,
	"current_event_id" uuid,
	"pending_draft_id" uuid,
	CONSTRAINT "receiving_roots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "receiving_roots_number_uq" UNIQUE("tenant_id","event_number"),
	CONSTRAINT "receiving_roots_version_valid" CHECK ("receiving_event_roots"."lifecycle_version" > 0),
	CONSTRAINT "receiving_roots_revision_valid" CHECK ("receiving_event_roots"."next_revision" > 1),
	CONSTRAINT "receiving_roots_number_valid" CHECK ("receiving_event_roots"."event_number" ~ '^REC-[0-9]{2}-[0-9]{4,10}$')
);
--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_number_uq";--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "root_event_id" uuid;
--> statement-breakpoint
INSERT INTO receiving_event_roots(id, tenant_id, event_number, lifecycle_version, next_revision, current_event_id, pending_draft_id)
SELECT id, tenant_id, event_number, CASE WHEN status='finalized' THEN 2 ELSE 1 END, 2,
  CASE WHEN status='finalized' THEN id END, CASE WHEN status='draft' THEN id END
FROM traceability_events;
--> statement-breakpoint
-- A transaction-local, exact-column-only backfill guard. Never disable triggers
-- or rewrite historical headers/snapshots. Restore the entire original function
-- definition, rather than reconstructing any version-pinned validation logic.
DO $backfill$
DECLARE original_guard text;
BEGIN
  SELECT pg_get_functiondef('receiving_header_finalization_guard()'::regprocedure) INTO original_guard;
  EXECUTE $definition$
    CREATE OR REPLACE FUNCTION receiving_header_finalization_guard() RETURNS trigger
    LANGUAGE plpgsql AS $guard$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.root_event_id IS NULL AND NEW.root_event_id = OLD.id
        AND (to_jsonb(NEW)-'root_event_id') IS NOT DISTINCT FROM (to_jsonb(OLD)-'root_event_id')
      THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'Only the Receiving root backfill is permitted' USING ERRCODE='23514';
    END
    $guard$;
  $definition$;
  UPDATE traceability_events SET root_event_id=id;
  EXECUTE original_guard;
END
$backfill$;
--> statement-breakpoint
ALTER TABLE "traceability_events" ALTER COLUMN "root_event_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_root_id_uq" UNIQUE("tenant_id","root_event_id","id");--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_root_revision_uq" UNIQUE("tenant_id","root_event_id","revision");--> statement-breakpoint
ALTER TABLE "receiving_event_roots" ADD CONSTRAINT "receiving_event_roots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_roots" ADD CONSTRAINT "receiving_roots_current_fk" FOREIGN KEY ("tenant_id","id","current_event_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "receiving_event_roots" ADD CONSTRAINT "receiving_roots_pending_fk" FOREIGN KEY ("tenant_id","id","pending_draft_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_root_fk" FOREIGN KEY ("tenant_id","root_event_id") REFERENCES "public"."receiving_event_roots"("tenant_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION receiving_event_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Persisted Receiving identities cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.root_event_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Original Receiving must anchor its own root' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.tenant_id,NEW.root_event_id,NEW.event_number,NEW.revision,NEW.time_zone,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.root_event_id,OLD.event_number,OLD.revision,OLD.time_zone,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Receiving identity and provenance are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER receiving_event_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON traceability_events
FOR EACH ROW EXECUTE FUNCTION receiving_event_identity_guard();
--> statement-breakpoint
CREATE FUNCTION receiving_root_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Persisted Receiving roots cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.event_number) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.event_number)
    OR NEW.lifecycle_version < OLD.lifecycle_version OR NEW.next_revision < OLD.next_revision
    OR (ROW(NEW.current_event_id,NEW.pending_draft_id) IS DISTINCT FROM ROW(OLD.current_event_id,OLD.pending_draft_id)
      AND NEW.lifecycle_version::bigint <> OLD.lifecycle_version::bigint+1) THEN
    RAISE EXCEPTION 'Receiving root identity or version transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER receiving_root_identity_guard BEFORE UPDATE OR DELETE ON receiving_event_roots
FOR EACH ROW EXECUTE FUNCTION receiving_root_identity_guard();
--> statement-breakpoint
CREATE FUNCTION receiving_original_root_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  root_id uuid;
  r receiving_event_roots%ROWTYPE;
  e traceability_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='receiving_event_roots' THEN root_id:=NEW.id;
  ELSE root_id:=NEW.root_event_id; END IF;
  -- Read the transaction's final state, not a NEW image queued by a child pulse.
  -- No reverse event -> root tuple lock: writers acquire root before event.
  SELECT * INTO r FROM receiving_event_roots WHERE tenant_id=NEW.tenant_id AND id=root_id;
  IF NOT FOUND THEN RETURN NULL; END IF; -- mandatory event FK reports 23503
  SELECT * INTO e FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving root must own an original event' USING ERRCODE='23514';
  END IF;
  -- Leave absent, cross-tenant and cross-root pointers to the composite FKs.
  IF (r.current_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.current_event_id))
    OR (r.pending_draft_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.pending_draft_id))
  THEN RETURN NULL; END IF;
  -- This slice intentionally does not open amendments, voids or revision > 1.
  IF e.event_number IS DISTINCT FROM r.event_number OR e.revision<>1 OR r.next_revision<>2
    OR (e.status='draft' AND (r.lifecycle_version<>1 OR r.current_event_id IS NOT NULL OR r.pending_draft_id IS DISTINCT FROM e.id))
    OR (e.status='finalized' AND (r.lifecycle_version<>2 OR r.current_event_id IS DISTINCT FROM e.id OR r.pending_draft_id IS NOT NULL))
  THEN RAISE EXCEPTION 'Receiving root does not match its original revision' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER receiving_root_consistency_guard AFTER INSERT OR UPDATE ON receiving_event_roots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receiving_original_root_consistency_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER receiving_event_root_consistency_guard AFTER INSERT OR UPDATE ON traceability_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receiving_original_root_consistency_guard();
