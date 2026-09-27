CREATE TABLE "lot_genealogy_edges" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('transformation'::text) STORED NOT NULL,
	"input_lot_id" uuid NOT NULL,
	"output_lot_id" uuid NOT NULL,
	CONSTRAINT "lot_genealogy_edges_tenant_id_event_id_input_lot_id_output_lot_id_pk" PRIMARY KEY("tenant_id","event_id","input_lot_id","output_lot_id"),
	CONSTRAINT "lot_genealogy_direction_valid" CHECK ("lot_genealogy_edges"."input_lot_id"<>"lot_genealogy_edges"."output_lot_id")
);
--> statement-breakpoint
CREATE TABLE "transformation_counters" (
	"tenant_id" text NOT NULL,
	"year" integer NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "transformation_counters_tenant_id_year_pk" PRIMARY KEY("tenant_id","year"),
	CONSTRAINT "transformation_counters_valid" CHECK ("transformation_counters"."year" BETWEEN 1 AND 9999 AND "transformation_counters"."sequence">0)
);
--> statement-breakpoint
CREATE TABLE "transformation_event_details" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('transformation'::text) STORED NOT NULL,
	"reason" text,
	"reason_note" text,
	CONSTRAINT "transformation_event_details_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "transformation_details_reason_valid" CHECK ("transformation_event_details"."reason" IN ('commingling_and_repacking','repacking','relabeling','processing','other')),
	CONSTRAINT "transformation_details_note_valid" CHECK (length(btrim("transformation_event_details"."reason_note")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "transformation_event_documents" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('transformation'::text) STORED NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "transformation_event_documents_tenant_id_event_id_document_id_pk" PRIMARY KEY("tenant_id","event_id","document_id"),
	CONSTRAINT "transformation_documents_position_uq" UNIQUE("tenant_id","event_id","position"),
	CONSTRAINT "transformation_documents_position_valid" CHECK ("transformation_event_documents"."position" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "transformation_event_inputs" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('transformation'::text) STORED NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"lot_id" uuid,
	"product_id" uuid,
	"source_location_id" uuid,
	"reference" text,
	"quantity" text,
	"unit_of_measure" text,
	CONSTRAINT "transformation_event_inputs_tenant_id_event_id_line_no_pk" PRIMARY KEY("tenant_id","event_id","line_no"),
	CONSTRAINT "transformation_inputs_lot_uq" UNIQUE("tenant_id","event_id","lot_id"),
	CONSTRAINT "transformation_inputs_line_valid" CHECK ("transformation_event_inputs"."line_no" BETWEEN 1 AND 100),
	CONSTRAINT "transformation_inputs_kind_valid" CHECK (("transformation_event_inputs"."kind"='ftl_lot' AND "transformation_event_inputs"."product_id" IS NULL AND "transformation_event_inputs"."source_location_id" IS NULL AND "transformation_event_inputs"."reference" IS NULL) OR ("transformation_event_inputs"."kind"='non_ftl' AND "transformation_event_inputs"."lot_id" IS NULL)),
	CONSTRAINT "transformation_inputs_reference_valid" CHECK (length(btrim("transformation_event_inputs"."reference")) BETWEEN 1 AND 2000),
	CONSTRAINT "transformation_inputs_quantity_valid" CHECK ("transformation_event_inputs"."quantity" ~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,3})?$' AND "transformation_event_inputs"."quantity"::numeric > 0),
	CONSTRAINT "transformation_inputs_uom_valid" CHECK ("transformation_event_inputs"."unit_of_measure" IN ('lb','oz','kg','g','each','case','bag','cup','gal','l'))
);
--> statement-breakpoint
CREATE TABLE "transformation_event_outputs" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('transformation'::text) STORED NOT NULL,
	"line_no" integer NOT NULL,
	"lot_id" uuid,
	"product_id" uuid,
	"tlc" text,
	"quantity" text,
	"unit_of_measure" text,
	CONSTRAINT "transformation_event_outputs_tenant_id_event_id_line_no_pk" PRIMARY KEY("tenant_id","event_id","line_no"),
	CONSTRAINT "transformation_outputs_lot_uq" UNIQUE("tenant_id","event_id","lot_id"),
	CONSTRAINT "transformation_outputs_line_valid" CHECK ("transformation_event_outputs"."line_no" BETWEEN 1 AND 100),
	CONSTRAINT "transformation_outputs_tlc_valid" CHECK (length("transformation_event_outputs"."tlc") BETWEEN 1 AND 120 AND "transformation_event_outputs"."tlc"=btrim("transformation_event_outputs"."tlc") AND "transformation_event_outputs"."tlc" !~ U&'[\0001-\001F\007F-\009F]'),
	CONSTRAINT "transformation_outputs_quantity_valid" CHECK ("transformation_event_outputs"."quantity" ~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,3})?$' AND "transformation_event_outputs"."quantity"::numeric > 0),
	CONSTRAINT "transformation_outputs_uom_valid" CHECK ("transformation_event_outputs"."unit_of_measure" IN ('lb','oz','kg','g','each','case','bag','cup','gal','l'))
);
--> statement-breakpoint
CREATE TABLE "transformation_operations" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('transformation'::text) STORED NOT NULL,
	"command" text NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transformation_operations_tenant_id_command_operation_key_pk" PRIMARY KEY("tenant_id","command","operation_key"),
	CONSTRAINT "transformation_operations_command_valid" CHECK ("transformation_operations"."command" IN ('transformation.create','transformation.save','transformation.finalize')),
	CONSTRAINT "transformation_operations_digest_valid" CHECK ("transformation_operations"."input_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "transformation_operations_result_valid" CHECK (jsonb_typeof("transformation_operations"."result")='object')
);
--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "transformation_event_roots" DROP CONSTRAINT "transformation_roots_draft_only";--> statement-breakpoint
ALTER TABLE "transformation_event_roots" ALTER COLUMN "pending_draft_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lot_genealogy_edges" ADD CONSTRAINT "lot_genealogy_edges_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_genealogy_edges" ADD CONSTRAINT "lot_genealogy_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_genealogy_edges" ADD CONSTRAINT "lot_genealogy_input_fk" FOREIGN KEY ("tenant_id","input_lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_genealogy_edges" ADD CONSTRAINT "lot_genealogy_output_fk" FOREIGN KEY ("tenant_id","output_lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_counters" ADD CONSTRAINT "transformation_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_details" ADD CONSTRAINT "transformation_event_details_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_details" ADD CONSTRAINT "transformation_details_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_documents" ADD CONSTRAINT "transformation_event_documents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_documents" ADD CONSTRAINT "transformation_documents_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_documents" ADD CONSTRAINT "transformation_documents_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."reference_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_inputs" ADD CONSTRAINT "transformation_event_inputs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_inputs" ADD CONSTRAINT "transformation_inputs_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_inputs" ADD CONSTRAINT "transformation_inputs_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_inputs" ADD CONSTRAINT "transformation_inputs_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_inputs" ADD CONSTRAINT "transformation_inputs_source_fk" FOREIGN KEY ("tenant_id","source_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_outputs" ADD CONSTRAINT "transformation_event_outputs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_outputs" ADD CONSTRAINT "transformation_outputs_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_outputs" ADD CONSTRAINT "transformation_outputs_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_event_outputs" ADD CONSTRAINT "transformation_outputs_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_operations" ADD CONSTRAINT "transformation_operations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformation_operations" ADD CONSTRAINT "transformation_operations_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lot_genealogy_input_idx" ON "lot_genealogy_edges" USING btree ("tenant_id","input_lot_id","event_id");--> statement-breakpoint
CREATE INDEX "lot_genealogy_output_idx" ON "lot_genealogy_edges" USING btree ("tenant_id","output_lot_id","event_id");--> statement-breakpoint
CREATE INDEX "transformation_inputs_lot_idx" ON "transformation_event_inputs" USING btree ("tenant_id","lot_id","event_id");--> statement-breakpoint
CREATE INDEX "transformation_outputs_lot_idx" ON "transformation_event_outputs" USING btree ("tenant_id","lot_id","event_id");--> statement-breakpoint
CREATE INDEX "transformation_operations_event_idx" ON "transformation_operations" USING btree ("tenant_id","event_id");--> statement-breakpoint
-- Serialize child writes with the header transition; KEY SHARE is insufficient
-- because finalization updates non-key columns. Lock both parents on row moves.
CREATE FUNCTION transformation_child_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;
BEGIN
  FOR e IN SELECT status,type FROM traceability_events
    WHERE (TG_OP<>'INSERT' AND tenant_id=OLD.tenant_id AND id=OLD.event_id)
       OR (TG_OP<>'DELETE' AND tenant_id=NEW.tenant_id AND id=NEW.event_id)
    ORDER BY tenant_id,id FOR UPDATE
  LOOP
    IF e.type<>'transformation' OR e.status<>'draft' THEN
      RAISE EXCEPTION 'Transformation evidence is immutable outside draft' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transformation_details_write_guard BEFORE INSERT OR UPDATE OR DELETE ON transformation_event_details FOR EACH ROW EXECUTE FUNCTION transformation_child_write_guard();
CREATE TRIGGER transformation_inputs_write_guard BEFORE INSERT OR UPDATE OR DELETE ON transformation_event_inputs FOR EACH ROW EXECUTE FUNCTION transformation_child_write_guard();
CREATE TRIGGER transformation_outputs_write_guard BEFORE INSERT OR UPDATE OR DELETE ON transformation_event_outputs FOR EACH ROW EXECUTE FUNCTION transformation_child_write_guard();
CREATE TRIGGER transformation_documents_write_guard BEFORE INSERT OR UPDATE OR DELETE ON transformation_event_documents FOR EACH ROW EXECUTE FUNCTION transformation_child_write_guard();
CREATE TRIGGER lot_genealogy_write_guard BEFORE INSERT OR UPDATE OR DELETE ON lot_genealogy_edges FOR EACH ROW EXECUTE FUNCTION transformation_child_write_guard();
CREATE FUNCTION transformation_operation_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Transformation operation results are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER transformation_operation_immutable_guard BEFORE UPDATE OR DELETE ON transformation_operations FOR EACH ROW EXECUTE FUNCTION transformation_operation_immutable_guard();
CREATE FUNCTION transformation_header_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type='transformation' AND OLD.status<>'draft' THEN
    RAISE EXCEPTION 'Finalized Transformation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transformation_header_write_guard BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION transformation_header_write_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transformation_root_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.current_event_id IS NOT NULL OR
    ROW(NEW.id,NEW.tenant_id,NEW.event_number,NEW.next_revision) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.event_number,OLD.next_revision)
  THEN RAISE EXCEPTION 'Transformation root identity/finalization is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION transformation_root_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid; r transformation_event_roots%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='transformation_event_roots' THEN root_id:=NEW.id; ELSE root_id:=NEW.root_event_id; END IF;
  SELECT * INTO r FROM transformation_event_roots WHERE tenant_id=NEW.tenant_id AND id=root_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM traceability_events e WHERE e.tenant_id=r.tenant_id AND e.id=r.id
    AND e.root_event_id=r.id AND e.type='transformation' AND e.revision=1 AND e.event_number=r.event_number
    AND ((e.status='draft' AND r.pending_draft_id=e.id AND r.current_event_id IS NULL)
      OR (e.status='finalized' AND r.current_event_id=e.id AND r.pending_draft_id IS NULL)))
  THEN RAISE EXCEPTION 'Inconsistent Transformation original pointers' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Read the transaction's final header, not the earlier NEW image of a deferred
-- draft insert. Typed children must already exist when finalization commits.
CREATE FUNCTION transformation_finalization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e traceability_events%ROWTYPE; d transformation_event_details%ROWTYPE;
  s jsonb; actual jsonb; expected jsonb; row_count integer;
BEGIN
  SELECT * INTO e FROM traceability_events WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  IF e.status<>'finalized' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM transformation_event_details WHERE tenant_id=e.tenant_id AND event_id=e.id;
  IF NOT FOUND OR d.reason IS NULL OR (d.reason='other' AND d.reason_note IS NULL) THEN
    RAISE EXCEPTION 'Transformation detail is required' USING ERRCODE='23514'; END IF;
  s:=e.finalization_snapshot;
  IF (s->'snapshotVersion') IS DISTINCT FROM '1'::jsonb OR (s->'revision') IS DISTINCT FROM '1'::jsonb
    OR s->>'eventId' IS DISTINCT FROM e.id::text OR s->>'eventNumber' IS DISTINCT FROM e.event_number
    OR s->>'eventDate' IS DISTINCT FROM e.event_date::text OR s->>'timeZone' IS DISTINCT FROM e.time_zone
    OR s#>>'{processor,id}' IS DISTINCT FROM e.location_id::text
    OR coalesce(length(btrim(s#>>'{processor,description}')),0)=0
    OR s->>'reason' IS DISTINCT FROM d.reason OR s->'reasonNote' IS DISTINCT FROM coalesce(to_jsonb(d.reason_note),'null'::jsonb)
    OR s->'notes' IS DISTINCT FROM coalesce(to_jsonb(e.notes),'null'::jsonb)
    OR s->>'finalizedBy' IS DISTINCT FROM e.finalized_by
    OR s->>'finalizedAt' IS NULL OR (s->>'finalizedAt')::timestamptz IS DISTINCT FROM e.finalized_at
    OR jsonb_typeof(s->'inputs') IS DISTINCT FROM 'array' OR jsonb_typeof(s->'outputs') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'documents') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Transformation snapshot header mismatch' USING ERRCODE='23514'; END IF;

  SELECT count(*),jsonb_agg(jsonb_build_object('lineNo',i.line_no,'kind',i.kind,'lotId',i.lot_id,
      'productId',CASE WHEN i.kind='ftl_lot' THEN l.product_id ELSE i.product_id END,
      'sourceId',CASE WHEN i.kind='ftl_lot' THEN coalesce(l.source_location_id,l.source_reference_location_id) ELSE i.source_location_id END,
      'tlc',CASE WHEN i.kind='ftl_lot' THEN l.tlc END,'reference',i.reference,'quantity',i.quantity,'unitOfMeasure',i.unit_of_measure) ORDER BY i.line_no)
    INTO row_count,expected FROM transformation_event_inputs i LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
    WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id;
  SELECT jsonb_agg(jsonb_build_object('lineNo',j->'lineNo','kind',j->'kind','lotId',j->'lotId',
    'productId',j#>'{product,id}','sourceId',j#>'{source,id}','tlc',j->'tlc','reference',j->'reference','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure') ORDER BY n)
    INTO actual FROM jsonb_array_elements(s->'inputs') WITH ORDINALITY a(j,n);
  IF row_count NOT BETWEEN 1 AND 100 OR actual IS DISTINCT FROM expected OR EXISTS (
    SELECT 1 FROM transformation_event_inputs i LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
    WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id AND (i.quantity IS NULL OR i.unit_of_measure IS NULL
      OR (i.kind='ftl_lot' AND (l.id IS NULL OR coalesce(l.source_location_id,l.source_reference_location_id) IS NULL))
      OR (i.kind='non_ftl' AND (i.product_id IS NULL OR i.source_location_id IS NULL OR i.reference IS NULL))))
  THEN RAISE EXCEPTION 'Transformation input snapshot mismatch' USING ERRCODE='23514'; END IF;

  SELECT count(*),jsonb_agg(jsonb_build_object('lineNo',o.line_no,'lotId',o.lot_id,'productId',o.product_id,
    'sourceId',e.location_id,'tlc',o.tlc,'quantity',o.quantity,'unitOfMeasure',o.unit_of_measure) ORDER BY o.line_no)
    INTO row_count,expected FROM transformation_event_outputs o WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id;
  SELECT jsonb_agg(jsonb_build_object('lineNo',j->'lineNo','lotId',j->'lotId','productId',j#>'{product,id}',
    'sourceId',j#>'{source,id}','tlc',j->'tlc','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure') ORDER BY n)
    INTO actual FROM jsonb_array_elements(s->'outputs') WITH ORDINALITY a(j,n);
  IF row_count NOT BETWEEN 1 AND 100 OR actual IS DISTINCT FROM expected OR EXISTS (
    SELECT 1 FROM transformation_event_outputs o LEFT JOIN traceability_lots l ON l.tenant_id=o.tenant_id AND l.id=o.lot_id
    WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id AND (o.quantity IS NULL OR o.unit_of_measure IS NULL OR o.tlc IS NULL OR o.product_id IS NULL
      OR l.id IS NULL OR l.product_id IS DISTINCT FROM o.product_id OR l.tlc IS DISTINCT FROM o.tlc
      OR l.source_location_id IS DISTINCT FROM e.location_id OR l.assignment_basis<>'transformation' OR l.source_locked_at IS NULL
      OR EXISTS(SELECT 1 FROM transformation_event_inputs i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id AND i.lot_id=o.lot_id)))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'outputs') j WHERE j->'source' IS DISTINCT FROM (s->'processor')||'{"kind":"location"}'::jsonb)
  THEN RAISE EXCEPTION 'Transformation output snapshot mismatch' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements((s->'inputs')||(s->'outputs')) j
    WHERE jsonb_typeof(j#>'{product,description}') IS DISTINCT FROM 'string' OR coalesce(length(btrim(j#>>'{product,description}')),0)=0
      OR jsonb_typeof(j#>'{source,description}') IS DISTINCT FROM 'string' OR coalesce(length(btrim(j#>>'{source,description}')),0)=0)
  THEN RAISE EXCEPTION 'Transformation descriptions required' USING ERRCODE='23514'; END IF;

  -- Freeze the actual source identity, including its opaque reference value. The id in a
  -- reference source is the resolved location described by the snapshot, not a replacement URL.
  SELECT jsonb_agg(CASE WHEN i.kind='ftl_lot' AND l.source_location_id IS NULL THEN
      jsonb_build_object('kind','reference','id',l.source_reference_location_id,
        'referenceKind',l.source_reference_kind,'referenceValue',l.source_reference_value)
    ELSE jsonb_build_object('kind','location','id',CASE WHEN i.kind='ftl_lot' THEN l.source_location_id ELSE i.source_location_id END)
    END ORDER BY i.line_no) INTO expected
    FROM transformation_event_inputs i LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
    WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id;
  SELECT jsonb_agg((j->'source')-'description' ORDER BY n) INTO actual
    FROM jsonb_array_elements(s->'inputs') WITH ORDINALITY a(j,n);
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Transformation source identity snapshot mismatch' USING ERRCODE='23514'; END IF;

  -- Every input and output product must retain its own reviewed coverage record. Match
  -- the server's millisecond UTC timestamp projection, without inventing reviewer evidence.
  IF EXISTS (
    WITH lines AS (
      SELECT CASE WHEN i.kind='ftl_lot' THEN l.product_id ELSE i.product_id END AS product_id,
        i.kind='ftl_lot' AS ftl, s->'inputs'->(i.line_no-1) AS j
        FROM transformation_event_inputs i LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
        WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id
      UNION ALL
      SELECT o.product_id, true, s->'outputs'->(o.line_no-1) FROM transformation_event_outputs o
        WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id
    )
    SELECT 1 FROM lines x LEFT JOIN product_traceability_profiles p ON p.tenant_id=e.tenant_id AND p.product_id=x.product_id
      WHERE p.product_id IS NULL OR p.reviewed_by IS NULL OR p.reviewed_at IS NULL OR p.coverage_rationale IS NULL
        OR (x.ftl AND (p.coverage_status NOT IN ('covered','contains_ftl_same_form')
          OR p.ftl_category IS NULL OR p.ftl_source_url IS NULL OR p.ftl_source_version IS NULL))
        OR (NOT x.ftl AND p.coverage_status<>'not_covered')
        OR x.j#>'{product,coverage}' IS DISTINCT FROM jsonb_build_object(
          'coverageStatus',p.coverage_status,'coverageRationale',p.coverage_rationale,
          'ftlCategory',p.ftl_category,'ftlSourceUrl',p.ftl_source_url,'ftlSourceVersion',p.ftl_source_version,
          'reviewedBy',p.reviewed_by,'reviewedAt',to_char(p.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ) THEN RAISE EXCEPTION 'Transformation coverage snapshot mismatch' USING ERRCODE='23514'; END IF;

  SELECT count(*),jsonb_agg(jsonb_build_object('id',r.id,'type',CASE WHEN r.type='other' THEN r.type_other_label ELSE r.type::text END,'number',r.number) ORDER BY l.position)
    INTO row_count,expected FROM transformation_event_documents l JOIN reference_documents r ON r.tenant_id=l.tenant_id AND r.id=l.document_id
    WHERE l.tenant_id=e.tenant_id AND l.event_id=e.id;
  IF row_count NOT BETWEEN 1 AND 100 OR s->'documents' IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Transformation document snapshot mismatch' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(i.lot_id,o.lot_id) ORDER BY i.lot_id,o.lot_id),'[]'::jsonb) INTO expected
    FROM transformation_event_inputs i JOIN transformation_event_outputs o ON o.tenant_id=i.tenant_id AND o.event_id=i.event_id
    WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id AND i.kind='ftl_lot';
  SELECT coalesce(jsonb_agg(jsonb_build_array(input_lot_id,output_lot_id) ORDER BY input_lot_id,output_lot_id),'[]'::jsonb) INTO actual
    FROM lot_genealogy_edges WHERE tenant_id=e.tenant_id AND event_id=e.id;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Transformation genealogy mismatch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'Invalid Transformation snapshot timestamp' USING ERRCODE='23514';
END $$;
CREATE CONSTRAINT TRIGGER transformation_finalization_guard AFTER INSERT OR UPDATE ON traceability_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='transformation') EXECUTE FUNCTION transformation_finalization_guard();
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
        AND jsonb_typeof("traceability_events"."finalization_snapshot") = 'object' AND "traceability_events"."event_date" IS NOT NULL
        AND "traceability_events"."location_id" IS NOT NULL AND "traceability_events"."previous_source_location_id" IS NOT NULL
        AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by")))
        OR ("traceability_events"."type" = 'transformation' AND "traceability_events"."revision" = 1 AND "traceability_events"."root_event_id" = "traceability_events"."id"
          AND "traceability_events"."previous_revision_id" IS NULL AND "traceability_events"."amendment_reason" IS NULL
          AND "traceability_events"."superseded_by_event_id" IS NULL AND "traceability_events"."superseded_at" IS NULL AND "traceability_events"."superseded_by" IS NULL
          AND "traceability_events"."voided_at" IS NULL AND "traceability_events"."voided_by" IS NULL AND "traceability_events"."void_reason" IS NULL
          AND (("traceability_events"."status" = 'draft' AND "traceability_events"."finalized_at" IS NULL AND "traceability_events"."finalized_by" IS NULL AND "traceability_events"."finalization_snapshot" IS NULL)
            OR ("traceability_events"."status" = 'finalized' AND "traceability_events"."finalized_at" IS NOT NULL AND "traceability_events"."finalized_by" IS NOT NULL AND length(btrim("traceability_events"."finalized_by")) BETWEEN 1 AND 128
              AND "traceability_events"."finalization_snapshot" IS NOT NULL AND jsonb_typeof("traceability_events"."finalization_snapshot") = 'object' AND "traceability_events"."event_date" IS NOT NULL AND "traceability_events"."location_id" IS NOT NULL
              AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by"))));--> statement-breakpoint
ALTER TABLE "transformation_event_roots" ADD CONSTRAINT "transformation_roots_original_valid" CHECK ("transformation_event_roots"."next_revision" = 2 AND (("transformation_event_roots"."lifecycle_version" = 1 AND "transformation_event_roots"."current_event_id" IS NULL AND "transformation_event_roots"."pending_draft_id" IS NOT NULL AND "transformation_event_roots"."pending_draft_id" = "transformation_event_roots"."id") OR ("transformation_event_roots"."lifecycle_version" = 2 AND "transformation_event_roots"."current_event_id" IS NOT NULL AND "transformation_event_roots"."current_event_id" = "transformation_event_roots"."id" AND "transformation_event_roots"."pending_draft_id" IS NULL)));
