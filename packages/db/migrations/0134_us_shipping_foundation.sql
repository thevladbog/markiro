CREATE TABLE "shipping_event_roots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_number" text NOT NULL,
	"lifecycle_version" integer DEFAULT 1 NOT NULL,
	"next_revision" integer DEFAULT 2 NOT NULL,
	"current_event_id" uuid,
	"pending_draft_id" uuid,
	CONSTRAINT "shipping_roots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shipping_roots_number_uq" UNIQUE("tenant_id","event_number"),
	CONSTRAINT "shipping_roots_revision_valid" CHECK ("shipping_event_roots"."lifecycle_version" > 0 AND "shipping_event_roots"."next_revision" > 1 AND ("shipping_event_roots"."current_event_id" IS NULL OR "shipping_event_roots"."current_event_id" IS DISTINCT FROM "shipping_event_roots"."pending_draft_id")),
	CONSTRAINT "shipping_roots_number_valid" CHECK ("shipping_event_roots"."event_number" ~ '^SHP-[0-9]{2}-[0-9]{4,10}$')
);
--> statement-breakpoint
CREATE TABLE "shipping_event_details" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('shipping'::text) STORED NOT NULL,
	"recipient_location_id" uuid,
	"recipient_snapshot" jsonb,
	"carrier_reference" text,
	CONSTRAINT "shipping_event_details_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "shipping_details_carrier_valid" CHECK (length(btrim("shipping_event_details"."carrier_reference")) BETWEEN 1 AND 2000),
	CONSTRAINT "shipping_details_snapshot_valid" CHECK ("shipping_event_details"."recipient_snapshot" IS NULL OR jsonb_typeof("shipping_event_details"."recipient_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "shipping_event_documents" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('shipping'::text) STORED NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "shipping_event_documents_tenant_id_event_id_document_id_pk" PRIMARY KEY("tenant_id","event_id","document_id"),
	CONSTRAINT "shipping_documents_position_uq" UNIQUE("tenant_id","event_id","position"),
	CONSTRAINT "shipping_documents_position_valid" CHECK ("shipping_event_documents"."position" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "shipping_event_items" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('shipping'::text) STORED NOT NULL,
	"line_no" integer NOT NULL,
	"lot_id" uuid NOT NULL,
	"quantity" text,
	"unit_of_measure" text,
	"tlc_snapshot" text,
	"source_snapshot" jsonb,
	"product_snapshot" jsonb,
	CONSTRAINT "shipping_event_items_tenant_id_event_id_line_no_pk" PRIMARY KEY("tenant_id","event_id","line_no"),
	CONSTRAINT "shipping_items_lot_uq" UNIQUE("tenant_id","event_id","lot_id"),
	CONSTRAINT "shipping_items_line_valid" CHECK ("shipping_event_items"."line_no" BETWEEN 1 AND 100),
	CONSTRAINT "shipping_items_quantity_valid" CHECK ("shipping_event_items"."quantity" ~ '^(0|[1-9][0-9]{0,14})([.][0-9]{1,3})?$' AND "shipping_event_items"."quantity" ~ '[1-9]'),
	CONSTRAINT "shipping_items_uom_valid" CHECK ("shipping_event_items"."unit_of_measure" IN ('lb','oz','kg','g','each','case','bag','cup','gal','l')),
	CONSTRAINT "shipping_items_tlc_valid" CHECK (length("shipping_event_items"."tlc_snapshot") BETWEEN 1 AND 120 AND "shipping_event_items"."tlc_snapshot" = btrim("shipping_event_items"."tlc_snapshot")),
	CONSTRAINT "shipping_items_snapshots_valid" CHECK (("shipping_event_items"."source_snapshot" IS NULL OR jsonb_typeof("shipping_event_items"."source_snapshot")='object') AND ("shipping_event_items"."product_snapshot" IS NULL OR jsonb_typeof("shipping_event_items"."product_snapshot")='object'))
);
--> statement-breakpoint
CREATE TABLE "shipping_lot_status_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('shipping'::text) STORED NOT NULL,
	"lot_id" uuid NOT NULL,
	"prior_status" text NOT NULL,
	"new_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"compensated_at" timestamp with time zone,
	"compensation_reason" text,
	CONSTRAINT "shipping_effects_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shipping_effects_status_valid" CHECK ("shipping_lot_status_effects"."prior_status"='active' AND "shipping_lot_status_effects"."new_status"='shipped'),
	CONSTRAINT "shipping_effects_compensation_valid" CHECK (("shipping_lot_status_effects"."compensated_at" IS NULL AND "shipping_lot_status_effects"."compensation_reason" IS NULL) OR ("shipping_lot_status_effects"."compensated_at" IS NOT NULL AND length(btrim("shipping_lot_status_effects"."compensation_reason")) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_number_valid";--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "shipping_root_key" uuid GENERATED ALWAYS AS (CASE WHEN type = 'shipping' THEN root_event_id END) STORED;--> statement-breakpoint
ALTER TABLE "shipping_event_roots" ADD CONSTRAINT "shipping_event_roots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_roots" ADD CONSTRAINT "shipping_roots_current_fk" FOREIGN KEY ("tenant_id","id","current_event_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_roots" ADD CONSTRAINT "shipping_roots_pending_fk" FOREIGN KEY ("tenant_id","id","pending_draft_id") REFERENCES "public"."traceability_events"("tenant_id","root_event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_details" ADD CONSTRAINT "shipping_event_details_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_details" ADD CONSTRAINT "shipping_details_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_details" ADD CONSTRAINT "shipping_details_recipient_fk" FOREIGN KEY ("tenant_id","recipient_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_documents" ADD CONSTRAINT "shipping_event_documents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_documents" ADD CONSTRAINT "shipping_documents_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_documents" ADD CONSTRAINT "shipping_documents_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."reference_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_items" ADD CONSTRAINT "shipping_event_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_items" ADD CONSTRAINT "shipping_items_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_event_items" ADD CONSTRAINT "shipping_items_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_lot_status_effects" ADD CONSTRAINT "shipping_lot_status_effects_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_lot_status_effects" ADD CONSTRAINT "shipping_effects_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_lot_status_effects" ADD CONSTRAINT "shipping_effects_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipping_items_lot_idx" ON "shipping_event_items" USING btree ("tenant_id","lot_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_effects_one_active_lot_uq" ON "shipping_lot_status_effects" USING btree ("tenant_id","lot_id") WHERE "shipping_lot_status_effects"."compensated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shipping_effects_event_idx" ON "shipping_lot_status_effects" USING btree ("tenant_id","event_id");--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_shipping_root_fk" FOREIGN KEY ("tenant_id","shipping_root_key") REFERENCES "public"."shipping_event_roots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
              AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by")))
        OR ("traceability_events"."type" = 'shipping' AND "traceability_events"."revision" > 0
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
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_number_valid" CHECK (("traceability_events"."type" = 'receiving' AND "traceability_events"."event_number" ~ '^REC-[0-9]{2}-[0-9]{4,10}$') OR ("traceability_events"."type" = 'transformation' AND "traceability_events"."event_number" ~ '^TRN-[0-9]{2}-[0-9]{4,10}$') OR ("traceability_events"."type" = 'shipping' AND "traceability_events"."event_number" ~ '^SHP-[0-9]{2}-[0-9]{4,10}$'));
--> statement-breakpoint
-- The event and typed root are inserted in one transaction, in either order.
ALTER TABLE traceability_events ALTER CONSTRAINT traceability_events_shipping_root_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE shipping_event_roots ALTER CONSTRAINT shipping_roots_current_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE shipping_event_roots ALTER CONSTRAINT shipping_roots_pending_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION shipping_root_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.tenant_id,NEW.event_number)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.event_number)
  THEN RAISE EXCEPTION 'Shipping root identity is immutable' USING ERRCODE='23514'; END IF;
  IF NEW IS DISTINCT FROM OLD AND (NEW.lifecycle_version<>OLD.lifecycle_version+1 OR
    ROW(NEW.current_event_id,NEW.pending_draft_id,NEW.next_revision)
      IS NOT DISTINCT FROM ROW(OLD.current_event_id,OLD.pending_draft_id,OLD.next_revision))
  THEN RAISE EXCEPTION 'Shipping root lifecycle version must follow a pointer change' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_root_identity_guard BEFORE UPDATE OR DELETE ON shipping_event_roots
  FOR EACH ROW EXECUTE FUNCTION shipping_root_identity_guard();
--> statement-breakpoint
CREATE FUNCTION shipping_root_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid; r shipping_event_roots%ROWTYPE; e traceability_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='shipping_event_roots' THEN root_id:=NEW.id; ELSE root_id:=NEW.root_event_id; END IF;
  SELECT * INTO r FROM shipping_event_roots WHERE tenant_id=NEW.tenant_id AND id=root_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO e FROM traceability_events WHERE tenant_id=r.tenant_id AND id=r.id;
  IF NOT FOUND OR e.type<>'shipping' OR e.root_event_id<>r.id OR e.revision<>1 OR e.event_number<>r.event_number
    OR r.next_revision IS DISTINCT FROM (SELECT max(revision)+1 FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND type='shipping')
    OR r.next_revision-1 IS DISTINCT FROM (SELECT count(*) FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND type='shipping')
    OR EXISTS (SELECT 1 FROM traceability_events x WHERE x.tenant_id=r.tenant_id AND x.root_event_id=r.id AND x.type='shipping'
      AND (x.event_number IS DISTINCT FROM r.event_number OR x.time_zone IS DISTINCT FROM e.time_zone
        OR (x.status='finalized') IS DISTINCT FROM (x.id IS NOT DISTINCT FROM r.current_event_id)
        OR (x.status='draft') IS DISTINCT FROM (x.id IS NOT DISTINCT FROM r.pending_draft_id)
        OR (x.revision>1 AND NOT EXISTS (SELECT 1 FROM traceability_events p
          WHERE p.tenant_id=x.tenant_id AND p.root_event_id=x.root_event_id AND p.id=x.previous_revision_id
            AND p.type='shipping' AND p.revision<x.revision
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
  THEN RAISE EXCEPTION 'Inconsistent Shipping revision pointers' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shipping_root_consistency_guard AFTER INSERT OR UPDATE ON shipping_event_roots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping_root_consistency_guard();
CREATE CONSTRAINT TRIGGER shipping_event_root_consistency_guard AFTER INSERT OR UPDATE ON traceability_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='shipping') EXECUTE FUNCTION shipping_root_consistency_guard();
--> statement-breakpoint
-- Serialize child writes with lifecycle changes, and retain finalized evidence.
CREATE FUNCTION shipping_child_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;
BEGIN
  FOR e IN SELECT status,type FROM traceability_events
    WHERE (TG_OP<>'INSERT' AND tenant_id=OLD.tenant_id AND id=OLD.event_id)
       OR (TG_OP<>'DELETE' AND tenant_id=NEW.tenant_id AND id=NEW.event_id)
    ORDER BY tenant_id,id FOR UPDATE
  LOOP
    IF e.type<>'shipping' OR e.status<>'draft' THEN
      RAISE EXCEPTION 'Shipping evidence is immutable outside draft' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_details_write_guard BEFORE INSERT OR UPDATE OR DELETE ON shipping_event_details FOR EACH ROW EXECUTE FUNCTION shipping_child_write_guard();
CREATE TRIGGER shipping_items_write_guard BEFORE INSERT OR UPDATE OR DELETE ON shipping_event_items FOR EACH ROW EXECUTE FUNCTION shipping_child_write_guard();
CREATE TRIGGER shipping_documents_write_guard BEFORE INSERT OR UPDATE OR DELETE ON shipping_event_documents FOR EACH ROW EXECUTE FUNCTION shipping_child_write_guard();
--> statement-breakpoint
CREATE FUNCTION shipping_header_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.type='shipping' AND NEW.status<>'draft' THEN
      RAISE EXCEPTION 'Shipping must begin as a draft' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.type<>'shipping' THEN RETURN NEW; END IF;
  IF OLD.status IN ('amended','void') THEN
    RAISE EXCEPTION 'Historical Shipping lifecycle is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.status='finalized' THEN
    IF NEW.status NOT IN ('amended','void') OR
      (to_jsonb(NEW)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by','voided_at','voided_by','void_reason','receiving_root_key','transformation_root_key','shipping_root_key'])
        IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by','voided_at','voided_by','void_reason','receiving_root_key','transformation_root_key','shipping_root_key'])
    THEN RAISE EXCEPTION 'Finalized Shipping evidence is immutable' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status='draft' AND NEW.status NOT IN ('draft','finalized','void') THEN
    RAISE EXCEPTION 'Invalid Shipping lifecycle transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_header_write_guard BEFORE INSERT OR UPDATE ON traceability_events
  FOR EACH ROW EXECUTE FUNCTION shipping_header_write_guard();
--> statement-breakpoint
-- Keep the existing Transformation guard's row comparison aligned with the
-- additive generated column, without changing its lifecycle rules.
DO $$
DECLARE original text; revised text;
BEGIN
  original:=pg_get_functiondef('transformation_header_write_guard()'::regprocedure);
  revised:=replace(original, '''receiving_root_key'',''transformation_root_key''',
    '''receiving_root_key'',''transformation_root_key'',''shipping_root_key''');
  IF revised=original THEN RAISE EXCEPTION 'Transformation header guard shape changed'; END IF;
  EXECUTE revised;
END $$;
--> statement-breakpoint
CREATE FUNCTION shipping_effect_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (
    OLD.compensated_at IS NOT NULL OR NEW.compensated_at IS NULL OR
    (to_jsonb(NEW)-ARRAY['compensated_at','compensation_reason','event_type'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['compensated_at','compensation_reason','event_type'])))
  THEN RAISE EXCEPTION 'Shipping status effect history is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_effect_write_guard BEFORE UPDATE OR DELETE ON shipping_lot_status_effects
  FOR EACH ROW EXECUTE FUNCTION shipping_effect_write_guard();
--> statement-breakpoint
-- Draft rows may be incomplete. A finalized revision must have the typed
-- evidence that its immutable snapshot represents before the transaction ends.
CREATE FUNCTION shipping_finalization_structure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e traceability_events%ROWTYPE; d shipping_event_details%ROWTYPE;
  item_count integer; document_count integer;
BEGIN
  IF NEW.status<>'finalized' THEN RETURN NULL; END IF;
  SELECT * INTO e FROM traceability_events WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  SELECT * INTO d FROM shipping_event_details WHERE tenant_id=e.tenant_id AND event_id=e.id;
  IF NOT FOUND OR d.recipient_location_id IS NULL OR d.recipient_location_id=e.location_id
    OR d.recipient_snapshot IS NULL OR d.recipient_snapshot->>'id' IS DISTINCT FROM d.recipient_location_id::text
    OR coalesce(length(btrim(d.recipient_snapshot->>'description')),0)=0
  THEN RAISE EXCEPTION 'Shipping recipient evidence is incomplete' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO item_count FROM shipping_event_items WHERE tenant_id=e.tenant_id AND event_id=e.id;
  IF item_count NOT BETWEEN 1 AND 100 OR EXISTS (
    SELECT 1 FROM shipping_event_items i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id
      AND (i.quantity IS NULL OR i.unit_of_measure IS NULL OR i.tlc_snapshot IS NULL
        OR i.source_snapshot IS NULL OR i.product_snapshot IS NULL))
  THEN RAISE EXCEPTION 'Shipping line evidence is incomplete' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO document_count FROM shipping_event_documents WHERE tenant_id=e.tenant_id AND event_id=e.id;
  IF document_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Shipping document evidence is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shipping_finalization_structure_guard AFTER INSERT OR UPDATE ON traceability_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='shipping')
  EXECUTE FUNCTION shipping_finalization_structure_guard();
