-- Additive chain storage. Existing headers, children, snapshots, receipts and lot
-- tokens are not rewritten. Public lifecycle commands are a separate activation.
LOCK TABLE receiving_event_roots, traceability_events, receiving_event_items,
  receiving_event_documents, receiving_operations IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "receiving_operations" DROP CONSTRAINT "receiving_operations_command_valid";--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD COLUMN "previous_line_no" integer;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "previous_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "superseded_by_event_id" uuid;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "amendment_reason" text;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "receiving_previous_revision_fk" FOREIGN KEY ("tenant_id","root_event_id","previous_revision_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "receiving_superseded_by_fk" FOREIGN KEY ("tenant_id","root_event_id","superseded_by_event_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "receiving_one_current_uq" ON "traceability_events" USING btree ("tenant_id","root_event_id") WHERE "traceability_events"."status" = 'finalized';--> statement-breakpoint
CREATE UNIQUE INDEX "receiving_one_pending_uq" ON "traceability_events" USING btree ("tenant_id","root_event_id") WHERE "traceability_events"."status" = 'draft';--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_previous_line_uq" UNIQUE("tenant_id","event_id","previous_line_no");--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_previous_line_valid" CHECK ("receiving_event_items"."previous_line_no" BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "receiving_operations" ADD CONSTRAINT "receiving_operations_command_valid" CHECK ("receiving_operations"."command" IN ('receiving.create', 'receiving.save', 'receiving.finalize', 'receiving.amend', 'receiving.void'));--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_lifecycle_valid" CHECK ("traceability_events"."type" = 'receiving' AND "traceability_events"."revision" > 0
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
        AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by")));
--> statement-breakpoint
-- Keep the legacy function byte-for-byte; limit invocation to its versioned
-- draft-finalization path. Lifecycle and v3 each have independent guards.
DROP TRIGGER receiving_header_finalization_guard ON traceability_events;
CREATE TRIGGER receiving_header_finalization_guard BEFORE UPDATE ON traceability_events
FOR EACH ROW WHEN (OLD.status='draft' AND NEW.status='finalized'
  AND NEW.finalization_snapshot->'snapshotVersion' IS DISTINCT FROM '3'::jsonb)
EXECUTE FUNCTION receiving_header_finalization_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION receiving_event_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r receiving_event_roots%ROWTYPE; p traceability_events%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Persisted Receiving identities cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN
      RAISE EXCEPTION 'Receiving must begin as a draft' USING ERRCODE='23514';
    END IF;
    IF NEW.revision=1 THEN
      IF NEW.root_event_id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Original Receiving must anchor its own root' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO r FROM receiving_event_roots WHERE tenant_id=NEW.tenant_id AND id=NEW.root_event_id;
      SELECT * INTO p FROM traceability_events WHERE tenant_id=NEW.tenant_id AND root_event_id=NEW.root_event_id AND id=NEW.previous_revision_id;
      IF p.id IS NULL OR p.status<>'finalized' OR r.current_event_id IS DISTINCT FROM p.id
        OR NEW.revision <> r.next_revision OR NEW.time_zone IS DISTINCT FROM p.time_zone
        OR NEW.event_number IS DISTINCT FROM r.event_number
        OR NOT receiving_text_v1_valid(NEW.amendment_reason,2000)
      THEN RAISE EXCEPTION 'Amendment must allocate the next revision of the current receipt' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.root_event_id,NEW.event_number,NEW.revision,NEW.time_zone,NEW.created_by,NEW.created_at,NEW.previous_revision_id,NEW.amendment_reason)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.root_event_id,OLD.event_number,OLD.revision,OLD.time_zone,OLD.created_by,OLD.created_at,OLD.previous_revision_id,OLD.amendment_reason)
  THEN RAISE EXCEPTION 'Receiving identity and provenance are immutable' USING ERRCODE='23514'; END IF;
  IF OLD.status IN ('amended','void') THEN
    RAISE EXCEPTION 'Terminal Receiving history is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status='void' THEN
    IF NOT receiving_text_v1_valid(NEW.void_reason,2000) OR NOT receiving_text_v1_valid(NEW.voided_by,128)
      OR (to_jsonb(NEW)-ARRAY['status','voided_at','voided_by','void_reason']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['status','voided_at','voided_by','void_reason'])
      OR (OLD.status='finalized' AND EXISTS (SELECT 1 FROM traceability_events
        WHERE tenant_id=OLD.tenant_id AND root_event_id=OLD.root_event_id AND status='draft'))
    THEN RAISE EXCEPTION 'Invalid Receiving void transition' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='finalized' THEN
    IF NEW.status<>'amended' OR NOT receiving_text_v1_valid(NEW.superseded_by,128)
      OR (to_jsonb(NEW)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by'])
    THEN RAISE EXCEPTION 'Frozen Receiving content is immutable' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status='finalized' THEN
    IF NEW.revision>1 AND NEW.finalization_snapshot->'snapshotVersion' IS DISTINCT FROM '3'::jsonb THEN
      RAISE EXCEPTION 'Amendment requires frozen v3 retained bindings' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status<>'draft' THEN
    RAISE EXCEPTION 'Invalid Receiving transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION receiving_root_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Persisted Receiving roots cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  allocation := NEW.pending_draft_id IS NOT NULL AND NEW.pending_draft_id IS DISTINCT FROM OLD.pending_draft_id;
  IF ROW(NEW.id,NEW.tenant_id,NEW.event_number) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.event_number)
    OR NEW.lifecycle_version::bigint<>OLD.lifecycle_version::bigint+1
    OR ROW(NEW.current_event_id,NEW.pending_draft_id) IS NOT DISTINCT FROM ROW(OLD.current_event_id,OLD.pending_draft_id)
    OR (allocation AND (OLD.pending_draft_id IS NOT NULL OR OLD.current_event_id IS NULL
      OR NEW.current_event_id IS DISTINCT FROM OLD.current_event_id OR NEW.next_revision::bigint<>OLD.next_revision::bigint+1))
    OR (NOT allocation AND NEW.next_revision<>OLD.next_revision)
    OR (OLD.current_event_id IS NULL AND OLD.pending_draft_id IS NULL)
  THEN RAISE EXCEPTION 'Invalid Receiving root transition or allocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION receiving_chain_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid; r receiving_event_roots%ROWTYPE; original traceability_events%ROWTYPE;
  allocated bigint; last_revision integer; expected_version bigint;
BEGIN
  IF TG_TABLE_NAME='receiving_event_roots' THEN root_id:=NEW.id; ELSE root_id:=NEW.root_event_id; END IF;
  SELECT * INTO r FROM receiving_event_roots WHERE tenant_id=NEW.tenant_id AND id=root_id;
  IF NOT FOUND THEN RETURN NULL; END IF; -- composite FK reports absence
  SELECT * INTO original FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.id AND revision=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing original Receiving' USING ERRCODE='23514'; END IF;
  SELECT count(*),max(revision),count(*)+count(*) FILTER (WHERE status<>'draft')+count(*) FILTER (WHERE status='void' AND finalization_snapshot IS NOT NULL)
    INTO allocated,last_revision,expected_version FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id;
  IF r.next_revision::bigint<>last_revision::bigint+1 OR allocated<>last_revision OR r.lifecycle_version<>expected_version
    OR EXISTS (SELECT 1 FROM traceability_events e
      LEFT JOIN traceability_events p ON p.tenant_id=e.tenant_id AND p.root_event_id=e.root_event_id AND p.id=e.previous_revision_id
      LEFT JOIN traceability_events s ON s.tenant_id=e.tenant_id AND s.root_event_id=e.root_event_id AND s.id=e.superseded_by_event_id
      WHERE e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND (
        e.event_number IS DISTINCT FROM r.event_number OR e.time_zone IS DISTINCT FROM original.time_zone
        OR (e.status='finalized' AND r.current_event_id IS DISTINCT FROM e.id)
        OR (e.status='draft' AND r.pending_draft_id IS DISTINCT FROM e.id)
        OR (e.revision>1 AND (p.id IS NULL OR p.revision>=e.revision OR p.finalization_snapshot IS NULL
          OR (e.status='draft' AND (p.status<>'finalized' OR r.current_event_id IS DISTINCT FROM p.id))
          OR (e.finalization_snapshot IS NOT NULL AND (p.status<>'amended' OR p.superseded_by_event_id IS DISTINCT FROM e.id))))
        OR (e.status='amended' AND (s.id IS NULL OR s.revision<=e.revision OR s.previous_revision_id IS DISTINCT FROM e.id
          OR s.finalization_snapshot IS NULL OR e.superseded_by IS DISTINCT FROM s.finalized_by OR e.superseded_at IS DISTINCT FROM s.finalized_at))
      ))
    OR (r.current_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.current_event_id AND status='finalized'))
    OR (r.pending_draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.pending_draft_id AND status='draft'))
  THEN RAISE EXCEPTION 'Inconsistent Receiving revision chain' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER receiving_root_consistency_guard ON receiving_event_roots;
DROP TRIGGER receiving_event_root_consistency_guard ON traceability_events;
CREATE CONSTRAINT TRIGGER receiving_root_consistency_guard AFTER INSERT OR UPDATE ON receiving_event_roots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receiving_chain_consistency_guard();
CREATE CONSTRAINT TRIGGER receiving_event_root_consistency_guard AFTER INSERT OR UPDATE ON traceability_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receiving_chain_consistency_guard();
--> statement-breakpoint
CREATE FUNCTION receiving_retained_line_matches(i receiving_event_items) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT p.finalization_snapshot IS NOT NULL
    AND ROW(i.product_id,i.lot_id,i.lot_link_mode,i.tlc,i.source_location_id,i.source_reference_kind,i.source_reference_value,i.source_reference_location_id,i.exempt_supplier)
      IS NOT DISTINCT FROM ROW(old.product_id,old.lot_id,old.lot_link_mode,old.tlc,old.source_location_id,old.source_reference_kind,old.source_reference_value,old.source_reference_location_id,old.exempt_supplier)
    AND (NOT i.exempt_supplier OR ROW(i.exempt_receipt->'tlcHandling',i.exempt_receipt->'proposedTlc')
      IS NOT DISTINCT FROM ROW(old.exempt_receipt->'tlcHandling',old.exempt_receipt->'proposedTlc'))
    FROM traceability_events e
    JOIN traceability_events p ON p.tenant_id=e.tenant_id AND p.root_event_id=e.root_event_id AND p.id=e.previous_revision_id
    JOIN receiving_event_items old ON old.tenant_id=p.tenant_id AND old.event_id=p.id AND old.line_no=i.previous_line_no
    WHERE e.tenant_id=i.tenant_id AND e.id=i.event_id),false)
$$;
--> statement-breakpoint
CREATE FUNCTION receiving_retained_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.previous_line_no IS NOT NULL AND NOT receiving_retained_line_matches(NEW) THEN
    RAISE EXCEPTION 'Retained Receiving lot identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_items_retained_guard BEFORE INSERT OR UPDATE ON receiving_event_items
FOR EACH ROW EXECUTE FUNCTION receiving_retained_item_guard();
--> statement-breakpoint
CREATE FUNCTION receiving_snapshot_v3_common(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT value || jsonb_build_object('snapshotVersion',2,
    'confirmation',(value->'confirmation') || '{"ruleVersion":"receiving-readiness-v3"}'::jsonb,
    'items',(SELECT jsonb_agg(item-'lotBinding' ORDER BY position)
      FROM jsonb_array_elements(value->'items') WITH ORDINALITY AS items(item,position)))
$$;
--> statement-breakpoint
CREATE FUNCTION receiving_snapshot_v3_shape_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; binding jsonb; seen text[]:=ARRAY[]::text[]; key text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->'snapshotVersion' IS DISTINCT FROM '3'::jsonb
    OR value->'confirmation'->'ruleVersion' IS DISTINCT FROM '"receiving-readiness-v4"'::jsonb
    OR jsonb_typeof(value->'items') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'items') LOOP
    binding:=item->'lotBinding';
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF binding->>'kind' IN ('created','linked') THEN
      IF binding-'kind'<>'{}'::jsonb OR (binding->>'kind'='created' AND item->>'lotLinkMode'<>'create_on_finalize')
        OR (binding->>'kind'='linked' AND item->>'lotLinkMode'<>'link_existing') THEN RETURN false; END IF;
    ELSIF binding->>'kind'='retained' THEN
      IF NOT binding ?& ARRAY['kind','previousEventId','previousLineNo']
        OR binding-ARRAY['kind','previousEventId','previousLineNo']<>'{}'::jsonb
        OR jsonb_typeof(binding->'previousEventId') IS DISTINCT FROM 'string'
        OR NOT coalesce(binding->>'previousEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)
        OR jsonb_typeof(binding->'previousLineNo') IS DISTINCT FROM 'number'
        OR NOT coalesce(binding->>'previousLineNo' ~ '^([1-9][0-9]?|100)$',false)
      THEN RETURN false; END IF;
      key:=lower(binding->>'previousEventId')||':'||(binding->>'previousLineNo');
      IF key=ANY(seen) THEN RETURN false; END IF; seen:=array_append(seen,key);
    ELSE RETURN false; END IF;
  END LOOP;
  RETURN coalesce(receiving_snapshot_v2_shape_valid(receiving_snapshot_v3_common(value)),false);
END $$;

--> statement-breakpoint
-- V3 retains the complete version-pinned common validation. Only proven retained
-- predecessor bindings bypass new-use status, new-assignment revision and site rules.
CREATE FUNCTION receiving_header_finalization_v3_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen jsonb; line_count integer; document_count integer; is_v2 boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Receiving must begin as a draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Finalized receiving is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.status = 'draft' THEN RETURN NEW; END IF;
  IF NOT receiving_snapshot_v3_shape_valid(NEW.finalization_snapshot) THEN
    RAISE EXCEPTION 'Invalid frozen Receiving v3 shape' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM receiving_event_items i
    WHERE i.tenant_id=NEW.tenant_id AND i.event_id=NEW.id AND (
      (i.previous_line_no IS NOT NULL AND (
        NOT receiving_retained_line_matches(i)
        OR NEW.finalization_snapshot->'items'->(i.line_no-1)->'lotBinding' IS DISTINCT FROM
          jsonb_build_object('kind','retained','previousEventId',NEW.previous_revision_id,'previousLineNo',i.previous_line_no)))
      OR (i.previous_line_no IS NULL AND
        NEW.finalization_snapshot->'items'->(i.line_no-1)->'lotBinding' IS DISTINCT FROM
          jsonb_build_object('kind',CASE WHEN i.lot_link_mode='create_on_finalize' THEN 'created' ELSE 'linked' END))
    )) THEN RAISE EXCEPTION 'Frozen lot binding does not match the saved predecessor line' USING ERRCODE='23514'; END IF;
  frozen := receiving_snapshot_v3_common(NEW.finalization_snapshot);
  IF frozen->'snapshotVersion' = '2'::jsonb THEN
    IF NOT coalesce(receiving_snapshot_v2_shape_valid(frozen),false) THEN
      RAISE EXCEPTION 'Invalid frozen receiving v2 shape' USING ERRCODE = '23514';
    END IF;
    is_v2 := true;
    frozen := receiving_snapshot_v2_common(frozen);
  END IF;
  IF NOT receiving_snapshot_v1_shape_valid(frozen)
    OR NOT receiving_text_v1_valid(NEW.finalized_by,128)
    OR (NEW.notes IS NOT NULL AND NOT receiving_text_v1_valid(NEW.notes,2000))
    OR (NEW.received_at_note IS NOT NULL AND NOT receiving_text_v1_valid(NEW.received_at_note,2000))
  THEN RAISE EXCEPTION 'Invalid frozen receiving v1 shape' USING ERRCODE = '23514'; END IF;
  IF NEW.status <> 'finalized'
    OR (to_jsonb(NEW) - ARRAY['status','finalized_at','finalized_by','finalization_snapshot','updated_at','updated_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','finalized_at','finalized_by','finalization_snapshot','updated_at','updated_by'])
    OR frozen->'snapshotVersion' IS DISTINCT FROM '1'::jsonb
    OR frozen->>'dateReceived' IS DISTINCT FROM NEW.date_received::text
    OR frozen->>'locationId' IS DISTINCT FROM NEW.location_id::text
    OR frozen->>'previousSourceLocationId' IS DISTINCT FROM NEW.previous_source_location_id::text
    OR frozen->'notes' IS DISTINCT FROM coalesce(to_jsonb(NEW.notes), 'null'::jsonb)
    OR frozen->'receivedAtNote' IS DISTINCT FROM coalesce(to_jsonb(NEW.received_at_note), 'null'::jsonb)
    OR jsonb_typeof(frozen->'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(frozen->'documents') IS DISTINCT FROM 'array'
    OR NOT receiving_location_snapshot_matches(frozen->'locationDescription',NEW.tenant_id,NEW.location_id)
    OR NOT receiving_location_snapshot_matches(frozen->'previousSourceDescription',NEW.tenant_id,NEW.previous_source_location_id)
    OR frozen->'confirmation'->>'ruleVersion' IS DISTINCT FROM 'receiving-readiness-v2'
    OR coalesce(frozen->'confirmation'->>'inputDigest','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(frozen->'confirmation'->'warnings') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Incomplete receiving finalization snapshot' USING ERRCODE = '23514'; END IF;
  SELECT count(*) INTO line_count FROM receiving_event_items WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id;
  SELECT count(*) INTO document_count FROM receiving_event_documents WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id;
  IF line_count NOT BETWEEN 1 AND 100 OR jsonb_array_length(frozen->'items') <> line_count
    OR jsonb_array_length(frozen->'documents') <> document_count
    OR (frozen->>'profileCode'='US_FSMA204_PROCESSOR' AND document_count=0)
    OR NOT EXISTS (SELECT 1 FROM traceability_profiles p WHERE p.tenant_id=NEW.tenant_id
      AND p.code::text=frozen->>'profileCode' AND p.baseline_version=frozen->>'baselineVersion')
    OR EXISTS (
      SELECT 1 FROM receiving_event_items i
      LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
      CROSS JOIN LATERAL (SELECT
        NEW.finalization_snapshot->'items'->(i.line_no-1)->'receiptBasis' AS basis,
        CASE WHEN is_v2 AND NEW.finalization_snapshot->'items'->(i.line_no-1)->'receiptBasis'->>'kind'='exempt_assigned_tlc'
          THEN i.exempt_receipt->>'proposedTlc' ELSE i.tlc END AS effective_tlc
      ) path
      WHERE i.tenant_id=NEW.tenant_id AND i.event_id=NEW.id AND (
        (NOT is_v2 AND i.exempt_supplier) OR i.product_id IS NULL OR i.lot_id IS NULL
        OR path.effective_tlc IS NULL OR i.quantity IS NULL OR i.unit_of_measure IS NULL
        OR path.effective_tlc <> receiving_trim_v1(path.effective_tlc)
        OR i.unit_of_measure NOT IN ('lb','oz','kg','g','each','case','bag','cup','gal','l')
        OR (i.supplier_lot_reference IS NOT NULL AND NOT receiving_text_v1_valid(i.supplier_lot_reference,128))
        OR (i.notes IS NOT NULL AND NOT receiving_text_v1_valid(i.notes,2000))
        OR (i.source_reference_value IS NOT NULL AND NOT receiving_text_v1_valid(i.source_reference_value,1024))
        OR l.source_locked_at IS NULL OR (i.previous_line_no IS NULL AND l.status <> 'active') OR l.product_id IS DISTINCT FROM i.product_id
        OR l.tlc IS DISTINCT FROM path.effective_tlc
        OR l.source_location_id IS DISTINCT FROM i.source_location_id
        OR l.source_reference_kind IS DISTINCT FROM i.source_reference_kind
        OR l.source_reference_value IS DISTINCT FROM i.source_reference_value
        OR l.source_reference_location_id IS DISTINCT FROM i.source_reference_location_id
        OR (is_v2 AND NOT coalesce((
          CASE path.basis->>'kind'
            WHEN 'ordinary' THEN NOT i.exempt_supplier
              AND (i.lot_link_mode='link_existing' OR l.assignment_basis='imported')
            WHEN 'exempt_existing_tlc' THEN
              i.exempt_supplier
              AND i.exempt_receipt->>'tlcHandling'='preserve_existing'
              AND i.exempt_receipt->'proposedTlc'='null'::jsonb
              AND i.tlc IS NOT NULL
              AND (i.lot_link_mode='link_existing' OR l.assignment_basis='imported')
            WHEN 'exempt_assigned_tlc' THEN
              i.exempt_supplier
              AND i.exempt_receipt->>'tlcHandling'='assign_if_missing'
              AND i.tlc IS NULL
              AND i.lot_link_mode='create_on_finalize'
              AND (i.previous_line_no IS NOT NULL OR i.source_location_id=NEW.location_id)
              AND i.source_reference_kind IS NULL AND i.source_reference_value IS NULL
              AND i.source_reference_location_id IS NULL
              AND l.assignment_basis='exempt_supplier_receipt'
              AND (i.previous_line_no IS NOT NULL OR l.revision=1)
            ELSE false
          END
          AND (path.basis->>'kind'='ordinary' OR (
            path.basis->>'reason'=i.exempt_reason
            AND path.basis->>'evidenceUrl'=i.exempt_receipt->>'evidenceUrl'
            AND path.basis->>'reviewedBy'=NEW.finalized_by
            -- The frozen review is millisecond precision; reject finer header
            -- instants instead of letting text formatting silently discard them.
            AND NEW.finalized_at=date_trunc('milliseconds',NEW.finalized_at)
            AND path.basis->>'reviewedAt'=to_char(NEW.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ))
        ),false))
        OR (frozen->'items'->(i.line_no-1)) IS NULL
        OR ((frozen->'items'->(i.line_no-1)) - ARRAY['productDescription','coverage','sourceDescription'])
          IS DISTINCT FROM jsonb_build_object('lineNo',i.line_no,'productId',i.product_id,'lotId',i.lot_id,
            'lotLinkMode',i.lot_link_mode,'tlc',path.effective_tlc,'quantity',i.quantity,'unitOfMeasure',i.unit_of_measure,
            'supplierLotReference',i.supplier_lot_reference,'notes',i.notes,'source',
            CASE WHEN i.source_location_id IS NOT NULL THEN jsonb_build_object('kind','location','locationId',i.source_location_id)
            ELSE jsonb_build_object('kind','reference','referenceKind',i.source_reference_kind,
              'referenceValue',i.source_reference_value,'resolvedLocationId',i.source_reference_location_id) END)
        OR NOT receiving_product_snapshot_matches(frozen->'items'->(i.line_no-1),NEW.tenant_id,i.product_id)
        OR NOT receiving_coverage_v1_valid(frozen->'items'->(i.line_no-1)->'coverage',frozen->>'profileCode')
        OR NOT receiving_location_snapshot_matches(frozen->'items'->(i.line_no-1)->'sourceDescription',
          NEW.tenant_id,coalesce(i.source_location_id,i.source_reference_location_id))
      )
    ) OR EXISTS (
      SELECT 1 FROM receiving_event_documents d
      JOIN reference_documents r ON r.tenant_id=d.tenant_id AND r.id=d.document_id
      LEFT JOIN traceability_parties p ON p.tenant_id=r.tenant_id AND p.id=r.party_id
      WHERE d.tenant_id=NEW.tenant_id AND d.event_id=NEW.id
      AND (NOT receiving_text_v1_valid(r.number,128)
        OR (r.type_other_label IS NOT NULL AND NOT receiving_text_v1_valid(r.type_other_label,200))
        OR (r.notes IS NOT NULL AND NOT receiving_text_v1_valid(r.notes,2000))
        OR (p.id IS NOT NULL AND (NOT receiving_text_v1_valid(p.name,200)
          OR (p.legal_name IS NOT NULL AND NOT receiving_text_v1_valid(p.legal_name,200))))
        OR frozen->'documents'->(d.position-1) IS DISTINCT FROM jsonb_build_object(
        'document',jsonb_build_object('snapshotVersion',1,'documentId',r.id,'type',r.type,'typeOtherLabel',r.type_other_label,
          'number',r.number,'partyId',r.party_id,'issuedOn',r.issued_on,'notes',r.notes),
        'issuer',CASE WHEN p.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',p.id,'name',p.name,'legalName',p.legal_name) END))
    )
  THEN RAISE EXCEPTION 'Incomplete receiving links or frozen payload' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE TRIGGER receiving_header_finalization_v3_guard BEFORE UPDATE ON traceability_events
FOR EACH ROW WHEN (OLD.status='draft' AND NEW.status='finalized'
  AND NEW.finalization_snapshot->'snapshotVersion'='3'::jsonb)
EXECUTE FUNCTION receiving_header_finalization_v3_guard();
