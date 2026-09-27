ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "transformation_event_roots" DROP CONSTRAINT "transformation_roots_original_valid";--> statement-breakpoint
ALTER TABLE "transformation_operations" DROP CONSTRAINT "transformation_operations_command_valid";--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD COLUMN "current_dependency_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD CONSTRAINT "traceability_lots_current_dependency_version_positive" CHECK ("traceability_lots"."current_dependency_version" > 0);--> statement-breakpoint
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
        AND jsonb_typeof("traceability_events"."finalization_snapshot") = 'object' AND "traceability_events"."event_date" IS NOT NULL
        AND "traceability_events"."location_id" IS NOT NULL AND "traceability_events"."previous_source_location_id" IS NOT NULL
        AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by")))
        OR ("traceability_events"."type" = 'transformation' AND "traceability_events"."revision" > 0
          AND (("traceability_events"."revision"=1 AND "traceability_events"."root_event_id"="traceability_events"."id" AND "traceability_events"."previous_revision_id" IS NULL AND "traceability_events"."amendment_reason" IS NULL)
            OR ("traceability_events"."revision">1 AND "traceability_events"."root_event_id"<>"traceability_events"."id" AND "traceability_events"."previous_revision_id" IS NOT NULL
              AND "traceability_events"."amendment_reason" IS NOT NULL AND length(btrim("traceability_events"."amendment_reason")) BETWEEN 1 AND 2000))
          AND (("traceability_events"."status"='amended' AND "traceability_events"."superseded_by_event_id" IS NOT NULL AND "traceability_events"."superseded_at" IS NOT NULL
              AND "traceability_events"."superseded_by" IS NOT NULL AND length(btrim("traceability_events"."superseded_by")) BETWEEN 1 AND 128)
            OR ("traceability_events"."status"<>'amended' AND "traceability_events"."superseded_by_event_id" IS NULL AND "traceability_events"."superseded_at" IS NULL AND "traceability_events"."superseded_by" IS NULL))
          AND (("traceability_events"."status"='void' AND "traceability_events"."voided_at" IS NOT NULL AND "traceability_events"."voided_by" IS NOT NULL
              AND length(btrim("traceability_events"."voided_by")) BETWEEN 1 AND 128 AND "traceability_events"."void_reason" IS NOT NULL
              AND length(btrim("traceability_events"."void_reason")) BETWEEN 1 AND 2000)
            OR ("traceability_events"."status"<>'void' AND "traceability_events"."voided_at" IS NULL AND "traceability_events"."voided_by" IS NULL AND "traceability_events"."void_reason" IS NULL))
          AND (("traceability_events"."status" IN ('draft','void') AND "traceability_events"."finalized_at" IS NULL AND "traceability_events"."finalized_by" IS NULL AND "traceability_events"."finalization_snapshot" IS NULL)
            OR ("traceability_events"."status" IN ('finalized','amended','void') AND "traceability_events"."finalized_at" IS NOT NULL AND "traceability_events"."finalized_by" IS NOT NULL
              AND length(btrim("traceability_events"."finalized_by")) BETWEEN 1 AND 128 AND "traceability_events"."finalization_snapshot" IS NOT NULL
              AND jsonb_typeof("traceability_events"."finalization_snapshot") = 'object' AND "traceability_events"."event_date" IS NOT NULL AND "traceability_events"."location_id" IS NOT NULL
              AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by"))));--> statement-breakpoint
ALTER TABLE "transformation_event_roots" ADD CONSTRAINT "transformation_roots_revision_valid" CHECK ("transformation_event_roots"."lifecycle_version" > 0 AND "transformation_event_roots"."next_revision" > 1 AND ("transformation_event_roots"."current_event_id" IS NULL OR "transformation_event_roots"."current_event_id" IS DISTINCT FROM "transformation_event_roots"."pending_draft_id"));--> statement-breakpoint
ALTER TABLE "transformation_operations" ADD CONSTRAINT "transformation_operations_command_valid" CHECK ("transformation_operations"."command" IN ('transformation.create','transformation.save','transformation.finalize','transformation.amend','transformation.void'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transformation_root_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    ROW(NEW.id,NEW.tenant_id,NEW.event_number) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.event_number)
  THEN RAISE EXCEPTION 'Transformation root identity is immutable' USING ERRCODE='23514'; END IF;
  IF NEW IS DISTINCT FROM OLD AND (NEW.lifecycle_version<>OLD.lifecycle_version+1 OR
    ROW(NEW.current_event_id,NEW.pending_draft_id,NEW.next_revision)
      IS NOT DISTINCT FROM ROW(OLD.current_event_id,OLD.pending_draft_id,OLD.next_revision))
  THEN RAISE EXCEPTION 'Transformation root lifecycle version must follow a pointer change' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transformation_header_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.type='transformation' AND NEW.status<>'draft' THEN
      RAISE EXCEPTION 'Transformation must begin as a draft' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.type<>'transformation' THEN RETURN NEW; END IF;
  IF OLD.status IN ('amended','void') THEN
    RAISE EXCEPTION 'Historical Transformation lifecycle is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='finalized' THEN
    IF NEW.status NOT IN ('amended','void') OR
      (to_jsonb(NEW)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by','voided_at','voided_by','void_reason','receiving_root_key','transformation_root_key'])
        IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by','voided_at','voided_by','void_reason','receiving_root_key','transformation_root_key'])
    THEN RAISE EXCEPTION 'Finalized Transformation evidence is immutable' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status='draft' AND NEW.status NOT IN ('draft','finalized','void') THEN
    RAISE EXCEPTION 'Invalid Transformation lifecycle transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER transformation_header_write_guard ON traceability_events;
CREATE TRIGGER transformation_header_write_guard BEFORE INSERT OR UPDATE ON traceability_events
  FOR EACH ROW EXECUTE FUNCTION transformation_header_write_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transformation_root_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid; r transformation_event_roots%ROWTYPE; e traceability_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='transformation_event_roots' THEN root_id:=NEW.id; ELSE root_id:=NEW.root_event_id; END IF;
  SELECT * INTO r FROM transformation_event_roots WHERE tenant_id=NEW.tenant_id AND id=root_id;
  IF NOT FOUND THEN RETURN NULL; END IF; -- the deferred FK reports missing roots
  SELECT * INTO e FROM traceability_events WHERE tenant_id=r.tenant_id AND id=r.id;
  IF NOT FOUND OR e.type<>'transformation' OR e.root_event_id<>r.id OR e.revision<>1 OR e.event_number<>r.event_number
    OR r.next_revision IS DISTINCT FROM (SELECT max(revision)+1 FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND type='transformation')
    OR r.next_revision-1 IS DISTINCT FROM (SELECT count(*) FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND type='transformation')
    OR EXISTS (SELECT 1 FROM traceability_events x WHERE x.tenant_id=r.tenant_id AND x.root_event_id=r.id AND x.type='transformation'
      AND (x.event_number IS DISTINCT FROM r.event_number OR x.time_zone IS DISTINCT FROM e.time_zone
        OR (x.status='finalized') IS DISTINCT FROM (x.id IS NOT DISTINCT FROM r.current_event_id)
        OR (x.status='draft') IS DISTINCT FROM (x.id IS NOT DISTINCT FROM r.pending_draft_id)
        OR (x.revision>1 AND NOT EXISTS (SELECT 1 FROM traceability_events p
          WHERE p.tenant_id=x.tenant_id AND p.root_event_id=x.root_event_id AND p.id=x.previous_revision_id
            AND p.type='transformation' AND p.revision<x.revision
            AND (p.status IN ('finalized','amended')
              OR (x.status='void' AND x.finalized_at IS NULL AND p.status='void'))))
        OR (x.status='amended' AND NOT EXISTS (SELECT 1 FROM traceability_events n
          WHERE n.tenant_id=x.tenant_id AND n.root_event_id=x.root_event_id AND n.id=x.superseded_by_event_id
            AND n.previous_revision_id=x.id AND n.status IN ('finalized','amended','void')))))
    OR (r.pending_draft_id IS NOT NULL AND r.current_event_id IS NULL AND r.pending_draft_id<>r.id)
    OR (r.pending_draft_id IS NOT NULL AND r.current_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM traceability_events p JOIN traceability_events d
        ON d.tenant_id=p.tenant_id AND d.root_event_id=p.root_event_id AND d.previous_revision_id=p.id
      WHERE p.tenant_id=r.tenant_id AND p.id=r.current_event_id AND d.id=r.pending_draft_id AND d.revision>p.revision))
  THEN RAISE EXCEPTION 'Inconsistent Transformation revision pointers' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Retain the 0131 snapshot validation except its original-only revision
-- comparison. Trigger NEW records a finalization even if the row is later
-- amended or voided before commit; existing historical rows are not rechecked.
DO $$
DECLARE definition text; revised text;
BEGIN
  definition:=pg_get_functiondef('transformation_finalization_guard()'::regprocedure);
  revised:=replace(definition, '(s->''revision'') IS DISTINCT FROM ''1''::jsonb', '(s->''revision'') IS DISTINCT FROM to_jsonb(e.revision)');
  IF revised=definition THEN RAISE EXCEPTION 'Original Transformation revision guard shape changed'; END IF;
  definition:=revised;
  revised:=replace(definition, 'IF e.status<>''finalized'' THEN RETURN NULL; END IF;', 'IF NEW.status<>''finalized'' THEN RETURN NULL; END IF;');
  IF revised=definition THEN RAISE EXCEPTION 'Original Transformation status guard shape changed'; END IF;
  EXECUTE revised;
END $$;
--> statement-breakpoint
CREATE FUNCTION transformation_revision_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e traceability_events%ROWTYPE; p traceability_events%ROWTYPE;
BEGIN
  SELECT * INTO e FROM traceability_events WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  IF NEW.status<>'finalized' OR e.revision=1 THEN RETURN NULL; END IF;
  SELECT * INTO p FROM traceability_events WHERE tenant_id=e.tenant_id AND id=e.previous_revision_id
    AND root_event_id=e.root_event_id AND type='transformation';
  IF NOT FOUND OR p.status<>'amended' OR p.superseded_by_event_id<>e.id OR p.revision>=e.revision
    OR e.location_id IS DISTINCT FROM p.location_id
    OR e.finalization_snapshot->>'previousRevisionId' IS DISTINCT FROM p.id::text
    OR EXISTS (SELECT line_no,lot_id,product_id,tlc FROM transformation_event_outputs
        WHERE tenant_id=e.tenant_id AND event_id=e.id
      EXCEPT SELECT line_no,lot_id,product_id,tlc FROM transformation_event_outputs
        WHERE tenant_id=p.tenant_id AND event_id=p.id)
    OR EXISTS (SELECT line_no,lot_id,product_id,tlc FROM transformation_event_outputs
        WHERE tenant_id=p.tenant_id AND event_id=p.id
      EXCEPT SELECT line_no,lot_id,product_id,tlc FROM transformation_event_outputs
        WHERE tenant_id=e.tenant_id AND event_id=e.id)
    OR EXISTS (SELECT 1 FROM transformation_event_outputs o JOIN traceability_lots l
        ON l.tenant_id=o.tenant_id AND l.id=o.lot_id
      WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id AND
        (l.assignment_basis<>'transformation' OR l.source_location_id IS DISTINCT FROM p.location_id OR l.source_locked_at IS NULL))
  THEN RAISE EXCEPTION 'Transformation revision output identity mismatch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transformation_revision_identity_guard AFTER INSERT OR UPDATE ON traceability_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='transformation')
  EXECUTE FUNCTION transformation_revision_identity_guard();
