-- Transactional constraint swap; generated stored columns rewrite the header table.
LOCK TABLE receiving_event_roots, traceability_events, receiving_event_items,
  receiving_event_documents, receiving_operations IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "transformation_event_roots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_number" text NOT NULL,
	"lifecycle_version" integer DEFAULT 1 NOT NULL,
	"next_revision" integer DEFAULT 2 NOT NULL,
	"current_event_id" uuid,
	"pending_draft_id" uuid NOT NULL,
	CONSTRAINT "transformation_roots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "transformation_roots_number_uq" UNIQUE("tenant_id","event_number"),
	CONSTRAINT "transformation_roots_draft_only" CHECK ("transformation_event_roots"."lifecycle_version" = 1 AND "transformation_event_roots"."next_revision" = 2 AND "transformation_event_roots"."current_event_id" IS NULL AND "transformation_event_roots"."pending_draft_id" = "transformation_event_roots"."id"),
	CONSTRAINT "transformation_roots_number_valid" CHECK ("transformation_event_roots"."event_number" ~ '^TRN-[0-9]{2}-[0-9]{4,10}$')
);
--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_number_valid";--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_root_fk";
--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "receiving_root_key" uuid GENERATED ALWAYS AS (CASE WHEN type = 'receiving' THEN root_event_id END) STORED;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "transformation_root_key" uuid GENERATED ALWAYS AS (CASE WHEN type = 'transformation' THEN root_event_id END) STORED;--> statement-breakpoint
ALTER TABLE "transformation_event_roots" ADD CONSTRAINT "transformation_event_roots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_roots" ADD CONSTRAINT "transformation_roots_current_fk" FOREIGN KEY ("tenant_id","id","current_event_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_roots" ADD CONSTRAINT "transformation_roots_pending_fk" FOREIGN KEY ("tenant_id","id","pending_draft_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_receiving_root_fk" FOREIGN KEY ("tenant_id","receiving_root_key") REFERENCES "public"."receiving_event_roots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_transformation_root_fk" FOREIGN KEY ("tenant_id","transformation_root_key") REFERENCES "public"."transformation_event_roots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_tenant_id_type_uq" UNIQUE("tenant_id","id","type");--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_typed_root_fk" FOREIGN KEY ("tenant_id","root_event_id","type") REFERENCES "public"."traceability_events"("tenant_id","id","type") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE transformation_event_roots ALTER CONSTRAINT transformation_roots_current_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE transformation_event_roots ALTER CONSTRAINT transformation_roots_pending_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE traceability_events ALTER CONSTRAINT traceability_events_receiving_root_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE traceability_events ALTER CONSTRAINT traceability_events_transformation_root_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_lifecycle_valid" CHECK (("traceability_events"."type" = 'receiving' AND "traceability_events"."revision" > 0
        AND (("traceability_events"."revision"=1 AND "traceability_events"."previous_revision_id" IS NULL AND "traceability_events"."amendment_reason" IS NULL)
          OR ("traceability_events"."revision">1 AND "traceability_events"."previous_revision_id" IS NOT NULL AND "traceability_events"."amendment_reason" IS NOT NULL AND length(btrim("traceability_events"."amendment_reason")) BETWEEN 1 AND 2000))
        AND (("traceability_events"."status"='amended' AND "traceability_events"."superseded_by_event_id" IS NOT NULL AND "traceability_events"."superseded_at" IS NOT NULL AND "traceability_events"."superseded_by" IS NOT NULL AND length(btrim("traceability_events"."superseded_by")) BETWEEN 1 AND 128)
          OR ("traceability_events"."status"<>'amended' AND "traceability_events"."superseded_by_event_id" IS NULL AND "traceability_events"."superseded_at" IS NULL AND "traceability_events"."superseded_by" IS NULL))
        AND (("traceability_events"."status"='void' AND "traceability_events"."voided_at" IS NOT NULL AND "traceability_events"."voided_by" IS NOT NULL AND length(btrim("traceability_events"."voided_by")) BETWEEN 1 AND 128 AND "traceability_events"."void_reason" IS NOT NULL AND length(btrim("traceability_events"."void_reason")) BETWEEN 1 AND 2000)
          OR ("traceability_events"."status"<>'void' AND "traceability_events"."voided_at" IS NULL AND "traceability_events"."voided_by" IS NULL AND "traceability_events"."void_reason" IS NULL))
        AND (
        ("traceability_events"."status" IN ('draft','void') AND "traceability_events"."finalized_at" IS NULL AND "traceability_events"."finalized_by" IS NULL AND "traceability_events"."finalization_snapshot" IS NULL)
        OR ("traceability_events"."status" IN ('finalized','amended','void') AND "traceability_events"."finalized_at" IS NOT NULL AND "traceability_events"."finalized_by" IS NOT NULL
        AND length(btrim("traceability_events"."finalized_by")) BETWEEN 1 AND 128 AND "traceability_events"."finalization_snapshot" IS NOT NULL
        AND jsonb_typeof("traceability_events"."finalization_snapshot") = 'object' AND "traceability_events"."date_received" IS NOT NULL
        AND "traceability_events"."location_id" IS NOT NULL AND "traceability_events"."previous_source_location_id" IS NOT NULL
        AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by")))
        OR ("traceability_events"."type" = 'transformation' AND "traceability_events"."status" = 'draft' AND "traceability_events"."revision" = 1 AND "traceability_events"."root_event_id" = "traceability_events"."id"
          AND "traceability_events"."previous_revision_id" IS NULL AND "traceability_events"."amendment_reason" IS NULL
          AND "traceability_events"."superseded_by_event_id" IS NULL AND "traceability_events"."superseded_at" IS NULL AND "traceability_events"."superseded_by" IS NULL
          AND "traceability_events"."voided_at" IS NULL AND "traceability_events"."voided_by" IS NULL AND "traceability_events"."void_reason" IS NULL
          AND "traceability_events"."finalized_at" IS NULL AND "traceability_events"."finalized_by" IS NULL AND "traceability_events"."finalization_snapshot" IS NULL));--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_number_valid" CHECK (("traceability_events"."type" = 'receiving' AND "traceability_events"."event_number" ~ '^REC-[0-9]{2}-[0-9]{4,10}$') OR ("traceability_events"."type" = 'transformation' AND "traceability_events"."event_number" ~ '^TRN-[0-9]{2}-[0-9]{4,10}$'));
--> statement-breakpoint
-- BEFORE triggers cannot read NEW's stored generated values. Exclude only these
-- two derived keys from the existing exact-row comparisons, retaining all
-- version-pinned snapshot and lifecycle checks from 0125/0126.
DO $$
DECLARE name text; definition text;
BEGIN
  FOREACH name IN ARRAY ARRAY['receiving_event_identity_guard', 'receiving_header_finalization_guard', 'receiving_header_finalization_v3_guard'] LOOP
    definition := pg_get_functiondef(to_regprocedure(name || '()'));
    definition := replace(definition, 'to_jsonb(NEW)', '(to_jsonb(NEW)-ARRAY[''receiving_root_key'',''transformation_root_key''])');
    definition := replace(definition, 'to_jsonb(OLD)', '(to_jsonb(OLD)-ARRAY[''receiving_root_key'',''transformation_root_key''])');
    EXECUTE definition;
  END LOOP;
END $$;
--> statement-breakpoint
DROP TRIGGER receiving_event_identity_guard ON traceability_events;
CREATE TRIGGER receiving_event_identity_guard BEFORE INSERT OR UPDATE ON traceability_events
FOR EACH ROW WHEN (NEW.type='receiving') EXECUTE FUNCTION receiving_event_identity_guard();
DROP TRIGGER receiving_header_finalization_guard ON traceability_events;
CREATE TRIGGER receiving_header_finalization_guard BEFORE UPDATE ON traceability_events
FOR EACH ROW WHEN (NEW.type='receiving' AND OLD.status='draft' AND NEW.status='finalized'
  AND NEW.finalization_snapshot->'snapshotVersion' IS DISTINCT FROM '3'::jsonb)
EXECUTE FUNCTION receiving_header_finalization_guard();
DROP TRIGGER receiving_header_finalization_v3_guard ON traceability_events;
CREATE TRIGGER receiving_header_finalization_v3_guard BEFORE UPDATE ON traceability_events
FOR EACH ROW WHEN (NEW.type='receiving' AND OLD.status='draft' AND NEW.status='finalized'
  AND NEW.finalization_snapshot->'snapshotVersion' = '3'::jsonb)
EXECUTE FUNCTION receiving_header_finalization_v3_guard();
DROP TRIGGER receiving_event_root_consistency_guard ON traceability_events;
CREATE CONSTRAINT TRIGGER receiving_event_root_consistency_guard AFTER INSERT OR UPDATE ON traceability_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='receiving') EXECUTE FUNCTION receiving_chain_consistency_guard();
--> statement-breakpoint
CREATE FUNCTION shared_event_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Persisted event identities cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.tenant_id,NEW.type,NEW.root_event_id,NEW.event_number,NEW.revision,NEW.time_zone,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.type,OLD.root_event_id,OLD.event_number,OLD.revision,OLD.time_zone,OLD.created_by,OLD.created_at)
  THEN RAISE EXCEPTION 'Event identity and provenance are immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.root_event_id<>NEW.id AND NOT EXISTS (
    SELECT 1 FROM traceability_events WHERE tenant_id=NEW.tenant_id AND id=NEW.root_event_id AND type=NEW.type
  ) THEN RAISE EXCEPTION 'Missing same-tenant typed root' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_shared_event_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON traceability_events
FOR EACH ROW EXECUTE FUNCTION shared_event_identity_guard();
--> statement-breakpoint
CREATE FUNCTION receiving_child_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  FOR parent IN SELECT e.type FROM traceability_events e
    WHERE (TG_OP<>'INSERT' AND e.tenant_id=OLD.tenant_id AND e.id=OLD.event_id)
       OR (TG_OP<>'DELETE' AND e.tenant_id=NEW.tenant_id AND e.id=NEW.event_id)
    ORDER BY e.tenant_id,e.id FOR KEY SHARE
  LOOP
    IF parent.type<>'receiving' THEN RAISE EXCEPTION 'Receiving child requires Receiving header' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_receiving_items_type_guard BEFORE INSERT OR UPDATE OR DELETE ON receiving_event_items FOR EACH ROW EXECUTE FUNCTION receiving_child_type_guard();
CREATE TRIGGER a_receiving_documents_type_guard BEFORE INSERT OR UPDATE OR DELETE ON receiving_event_documents FOR EACH ROW EXECUTE FUNCTION receiving_child_type_guard();
CREATE TRIGGER a_receiving_operations_type_guard BEFORE INSERT OR UPDATE OR DELETE ON receiving_operations FOR EACH ROW EXECUTE FUNCTION receiving_child_type_guard();
--> statement-breakpoint
CREATE FUNCTION transformation_root_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Transformation root lifecycle is not enabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transformation_root_identity_guard BEFORE UPDATE OR DELETE ON transformation_event_roots FOR EACH ROW EXECUTE FUNCTION transformation_root_identity_guard();
CREATE FUNCTION transformation_root_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid; r transformation_event_roots%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='transformation_event_roots' THEN root_id:=NEW.id; ELSE root_id:=NEW.root_event_id; END IF;
  SELECT * INTO r FROM transformation_event_roots WHERE tenant_id=NEW.tenant_id AND id=root_id;
  IF NOT FOUND THEN RETURN NULL; END IF; -- deferred FK reports absence
  IF NOT EXISTS (SELECT 1 FROM traceability_events e WHERE e.tenant_id=r.tenant_id AND e.id=r.id
    AND e.root_event_id=r.id AND e.type='transformation' AND e.status='draft' AND e.revision=1
    AND e.event_number=r.event_number AND r.pending_draft_id=e.id)
  THEN RAISE EXCEPTION 'Inconsistent Transformation original draft' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transformation_root_consistency_guard AFTER INSERT OR UPDATE ON transformation_event_roots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transformation_root_consistency_guard();
CREATE CONSTRAINT TRIGGER transformation_event_root_consistency_guard AFTER INSERT OR UPDATE ON traceability_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='transformation') EXECUTE FUNCTION transformation_root_consistency_guard();
