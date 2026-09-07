ALTER TABLE "receiving_operations" DROP CONSTRAINT "receiving_operations_command_valid";--> statement-breakpoint
ALTER TABLE "traceability_events" DROP CONSTRAINT "traceability_events_draft_only";--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "finalized_by" text;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD COLUMN "finalization_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "receiving_operations" ADD CONSTRAINT "receiving_operations_command_valid" CHECK ("receiving_operations"."command" IN ('receiving.create', 'receiving.save', 'receiving.finalize'));--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_lifecycle_valid" CHECK ("traceability_events"."type" = 'receiving' AND "traceability_events"."revision" = 1 AND (
        ("traceability_events"."status" = 'draft' AND "traceability_events"."finalized_at" IS NULL AND "traceability_events"."finalized_by" IS NULL AND "traceability_events"."finalization_snapshot" IS NULL)
        OR ("traceability_events"."status" = 'finalized' AND "traceability_events"."finalized_at" IS NOT NULL AND "traceability_events"."finalized_by" IS NOT NULL
        AND length(btrim("traceability_events"."finalized_by")) BETWEEN 1 AND 128 AND "traceability_events"."finalization_snapshot" IS NOT NULL
        AND jsonb_typeof("traceability_events"."finalization_snapshot") = 'object' AND "traceability_events"."date_received" IS NOT NULL
        AND "traceability_events"."location_id" IS NOT NULL AND "traceability_events"."previous_source_location_id" IS NOT NULL
        AND "traceability_events"."updated_at" = "traceability_events"."finalized_at" AND "traceability_events"."updated_by" = "traceability_events"."finalized_by")));
--> statement-breakpoint
-- Hand-maintained lifecycle guards. Pulse both sorted parents on every child mutation:
-- a lock alone does not invalidate an older repeatable-read snapshot of the child set.
-- Keep all parent business values, versions, timestamps and audit metadata unchanged.
CREATE FUNCTION receiving_child_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  FOR parent IN
    SELECT e.tenant_id, e.id, e.status FROM traceability_events e
    WHERE (TG_OP <> 'INSERT' AND e.tenant_id = OLD.tenant_id AND e.id = OLD.event_id)
       OR (TG_OP <> 'DELETE' AND e.tenant_id = NEW.tenant_id AND e.id = NEW.event_id)
    ORDER BY e.tenant_id, e.id FOR UPDATE
  LOOP
    IF parent.status <> 'draft' THEN
      RAISE EXCEPTION 'Finalized receiving children are immutable' USING ERRCODE = '23514';
    END IF;
    UPDATE traceability_events SET id=id WHERE tenant_id=parent.tenant_id AND id=parent.id;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER receiving_items_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON receiving_event_items
FOR EACH ROW EXECUTE FUNCTION receiving_child_draft_guard();
--> statement-breakpoint
CREATE TRIGGER receiving_documents_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON receiving_event_documents
FOR EACH ROW EXECUTE FUNCTION receiving_child_draft_guard();
--> statement-breakpoint
CREATE FUNCTION receiving_header_finalization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen jsonb; line_count integer; document_count integer;
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
  frozen := NEW.finalization_snapshot;
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
      WHERE i.tenant_id=NEW.tenant_id AND i.event_id=NEW.id AND (
        i.exempt_supplier OR i.product_id IS NULL OR i.lot_id IS NULL
        OR i.tlc IS NULL OR i.quantity IS NULL OR i.unit_of_measure IS NULL
        OR i.tlc <> receiving_trim_v1(i.tlc)
        OR i.unit_of_measure NOT IN ('lb','oz','kg','g','each','case','bag','cup','gal','l')
        OR (i.supplier_lot_reference IS NOT NULL AND NOT receiving_text_v1_valid(i.supplier_lot_reference,128))
        OR (i.notes IS NOT NULL AND NOT receiving_text_v1_valid(i.notes,2000))
        OR (i.source_reference_value IS NOT NULL AND NOT receiving_text_v1_valid(i.source_reference_value,1024))
        OR l.source_locked_at IS NULL OR l.status <> 'active' OR l.product_id IS DISTINCT FROM i.product_id
        OR l.tlc IS DISTINCT FROM i.tlc
        OR l.source_location_id IS DISTINCT FROM i.source_location_id
        OR l.source_reference_kind IS DISTINCT FROM i.source_reference_kind
        OR l.source_reference_value IS DISTINCT FROM i.source_reference_value
        OR l.source_reference_location_id IS DISTINCT FROM i.source_reference_location_id
        OR (frozen->'items'->(i.line_no-1)) IS NULL
        OR ((frozen->'items'->(i.line_no-1)) - ARRAY['productDescription','coverage','sourceDescription'])
          IS DISTINCT FROM jsonb_build_object('lineNo',i.line_no,'productId',i.product_id,'lotId',i.lot_id,
            'lotLinkMode',i.lot_link_mode,'tlc',i.tlc,'quantity',i.quantity,'unitOfMeasure',i.unit_of_measure,
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
CREATE TRIGGER receiving_header_finalization_guard BEFORE INSERT OR UPDATE OR DELETE ON traceability_events
FOR EACH ROW EXECUTE FUNCTION receiving_header_finalization_guard();
--> statement-breakpoint
-- Snapshot-v1 integrity checks only. New snapshot construction remains in the domain builders.
-- JSON/DB text cannot contain NUL or surrogate code points. Count UTF-16 units, not
-- Postgres code points, and pin ECMAScript trim whitespace to the frozen contract.
CREATE FUNCTION receiving_trim_v1(value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
--> statement-breakpoint
CREATE FUNCTION receiving_text_v1_valid(value text, maximum integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(length(receiving_trim_v1(value))>0
    AND length(value)+(SELECT count(*) FROM regexp_split_to_table(value,'') c WHERE ascii(c)>65535)<=maximum,false)
$$;
--> statement-breakpoint
CREATE FUNCTION receiving_snapshot_v1_shape_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE confirmation jsonb; warning jsonb;
  root_keys text[] := ARRAY['snapshotVersion','dateReceived','locationId','previousSourceLocationId','receivedAtNote','notes','profileCode','baselineVersion','locationDescription','previousSourceDescription','items','documents','confirmation'];
  confirmation_keys text[] := ARRAY['ruleVersion','inputDigest','warnings'];
  warning_keys text[] := ARRAY['severity','group','line','field','code','detail'];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF NOT value ?& root_keys OR value-root_keys <> '{}'::jsonb
    OR jsonb_typeof(value->'baselineVersion') IS DISTINCT FROM 'string'
    OR NOT receiving_text_v1_valid(value->>'baselineVersion',128)
    OR jsonb_typeof(value->'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'documents') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  IF jsonb_array_length(value->'documents')>100 THEN RETURN false; END IF;
  confirmation := value->'confirmation';
  IF jsonb_typeof(confirmation) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF NOT confirmation ?& confirmation_keys OR confirmation-confirmation_keys <> '{}'::jsonb
    OR confirmation->'ruleVersion' IS DISTINCT FROM '"receiving-readiness-v2"'::jsonb
    OR jsonb_typeof(confirmation->'inputDigest') IS DISTINCT FROM 'string'
    OR coalesce(confirmation->>'inputDigest','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(confirmation->'warnings') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  IF jsonb_array_length(confirmation->'warnings')>5000 THEN RETURN false; END IF;
  FOR warning IN SELECT * FROM jsonb_array_elements(confirmation->'warnings') LOOP
    IF jsonb_typeof(warning) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT warning ?& warning_keys OR warning-warning_keys <> '{}'::jsonb
      OR warning->'severity' IS DISTINCT FROM '"warning"'::jsonb
      OR jsonb_typeof(warning->'group') IS DISTINCT FROM 'string'
      OR jsonb_typeof(warning->'field') IS DISTINCT FROM 'string'
      OR jsonb_typeof(warning->'code') IS DISTINCT FROM 'string'
      OR jsonb_typeof(warning->'detail') NOT IN ('string','null')
      OR NOT coalesce(warning->'group' <@ '["header","lines","documents"]'::jsonb,false)
      OR NOT coalesce(warning->'field' <@ '["dateReceived","location","previousSource","items","product","coverage","tlc","source","quantity","unitOfMeasure","lot","exemption","documents"]'::jsonb,false)
      OR NOT coalesce(warning->'code' <@ '["required","format","unavailable","inactive","incomplete_description","wrong_role","coverage_unresolved","not_assessed","lot_product_mismatch","lot_tlc_mismatch","lot_source_mismatch","lot_link_inconsistent","duplicate_identity","exemption_review_required","tlc_assignment_required"]'::jsonb,false)
      OR NOT coalesce(warning->'detail' <@ '[null,"businessName","phoneNumber","addressKind","streetAddress","latitude","longitude","city","stateOrRegion","zipOrPostalCode","countryCode","productName","brandName","commodity","variety","packagingSizeValue","packagingSizeUom","packagingStyle","defaultQuantityUom","gtin","coverageStatus","coverageRationale","ftlCategory","ftlSourceUrl","ftlSourceVersion","reviewedBy","reviewedAt","exemptReason"]'::jsonb,false)
    THEN RETURN false; END IF;
    IF warning->'line' <> 'null'::jsonb THEN
      IF warning->>'group'<>'lines' OR jsonb_typeof(warning->'line')<>'number' THEN RETURN false; END IF;
      IF (warning->>'line')::numeric NOT BETWEEN 1 AND 100
        OR trunc((warning->>'line')::numeric)<>(warning->>'line')::numeric THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
-- Owner-approved URL boundary: SQL retains required text/bounds and exact stored
-- relationships. Full WHATWG/IDNA semantics belong to server validators/builders.
-- Privileged direct SQL can bypass those semantics; strict frozen reads fail closed.
CREATE FUNCTION receiving_coverage_v1_valid(value jsonb, profile text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text; maximum integer;
BEGIN
  -- Exact keys/types are also bound to the persisted profile by the matcher below.
  FOREACH field IN ARRAY ARRAY['coverageRationale','ftlCategory','ftlSourceUrl','ftlSourceVersion','reviewedBy'] LOOP
    maximum := CASE field WHEN 'coverageRationale' THEN 2000 WHEN 'ftlCategory' THEN 200 WHEN 'ftlSourceUrl' THEN 2048 ELSE 128 END;
    IF value->field <> 'null'::jsonb AND NOT receiving_text_v1_valid(value->>field,maximum) THEN RETURN false; END IF;
  END LOOP;
  IF profile='US_GENERIC_LOT_TRACEABILITY' THEN
    RETURN value = jsonb_build_object('coverageStatus','unknown','coverageRationale',NULL,'ftlCategory',NULL,'ftlSourceUrl',NULL,'ftlSourceVersion',NULL,'reviewedBy',NULL,'reviewedAt',NULL);
  END IF;
  IF profile<>'US_FSMA204_PROCESSOR' OR value->>'coverageStatus' NOT IN ('covered','contains_ftl_same_form','not_covered')
    OR value->'coverageRationale'='null'::jsonb OR value->'reviewedBy'='null'::jsonb OR value->'reviewedAt'='null'::jsonb
    OR coalesce(value->>'reviewedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  THEN RETURN false; END IF;
  IF value->>'coverageStatus' IN ('covered','contains_ftl_same_form')
    AND (value->'ftlCategory'='null'::jsonb OR value->'ftlSourceUrl'='null'::jsonb OR value->'ftlSourceVersion'='null'::jsonb)
  THEN RETURN false; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION receiving_location_snapshot_matches(value jsonb, tenant text, location uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value IS NOT DISTINCT FROM jsonb_build_object(
    'schemaVersion',1,'locationId',l.id,'partyId',l.party_id,'businessName',l.business_name,
    'phoneNumber',l.phone_number,'city',l.city,'stateOrRegion',l.state_or_region,
    'zipOrPostalCode',l.zip_or_postal_code,'countryCode',l.country_code,
    'countryDisplay',CASE l.country_code WHEN 'US' THEN 'United States' WHEN 'CA' THEN 'Canada' WHEN 'MX' THEN 'Mexico' ELSE l.country_code END,
    'address',CASE l.address_kind WHEN 'street' THEN jsonb_build_object('kind','street','streetAddress',l.street_address)
      ELSE jsonb_build_object('kind','coordinates','latitude',l.latitude::text,'longitude',l.longitude::text) END)
    AND l.phone_number IS NOT NULL AND l.city IS NOT NULL AND l.state_or_region IS NOT NULL
    AND l.zip_or_postal_code IS NOT NULL AND l.country_code IS NOT NULL
    AND receiving_text_v1_valid(l.business_name,200)
    AND receiving_text_v1_valid(l.phone_number,40) AND length(l.phone_number)>=3
    AND l.phone_number ~ '[0-9]' AND regexp_replace(l.phone_number,
      U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]',' ','g') ~* '^[0-9 +().,-]*((x|ext)[0-9 +().,-]*)?$'
    AND receiving_text_v1_valid(l.city,200) AND receiving_text_v1_valid(l.state_or_region,200)
    AND receiving_text_v1_valid(l.zip_or_postal_code,32)
    AND ((l.address_kind='street' AND receiving_text_v1_valid(l.street_address,500))
      OR (l.address_kind='coordinates' AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL))
    FROM traceability_locations l WHERE l.tenant_id=tenant AND l.id=location),false)
$$;
--> statement-breakpoint
CREATE FUNCTION receiving_product_snapshot_matches(value jsonb, tenant text, product uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value->'productDescription' IS NOT DISTINCT FROM jsonb_build_object(
    'snapshotVersion',1,'sourceProductId',p.id,'productName',receiving_trim_v1(coalesce(t.product_name,p.name)),
    'brandName',receiving_trim_v1(t.brand_name),'commodity',receiving_trim_v1(t.commodity),'variety',receiving_trim_v1(t.variety),
    'packagingSize',CASE WHEN t.packaging_size_value IS NULL THEN 'null'::jsonb
      ELSE jsonb_build_object('value',t.packaging_size_value::text,'uom',t.packaging_size_uom) END,
    'packagingStyle',receiving_trim_v1(t.packaging_style),'gtin',p.gtin14)
    AND value->'coverage' IS NOT DISTINCT FROM jsonb_build_object(
      'coverageStatus',coalesce(t.coverage_status::text,'unknown'),'coverageRationale',t.coverage_rationale,
      'ftlCategory',t.ftl_category,'ftlSourceUrl',t.ftl_source_url,'ftlSourceVersion',t.ftl_source_version,
      'reviewedBy',t.reviewed_by,'reviewedAt',to_char(t.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    AND receiving_text_v1_valid(receiving_trim_v1(coalesce(t.product_name,p.name)),200)
    AND (t.brand_name IS NULL OR receiving_text_v1_valid(receiving_trim_v1(t.brand_name),200))
    AND (t.commodity IS NULL OR receiving_text_v1_valid(receiving_trim_v1(t.commodity),200))
    AND (t.variety IS NULL OR receiving_text_v1_valid(receiving_trim_v1(t.variety),200))
    AND (t.packaging_style IS NULL OR receiving_text_v1_valid(receiving_trim_v1(t.packaging_style),200))
    AND (p.gtin14 IS NULL OR (p.gtin14 ~ '^[0-9]{14}$' AND (
      SELECT sum((ascii(substring(p.gtin14 FROM n FOR 1))-48)*CASE WHEN n%2=1 THEN 3 ELSE 1 END)%10=0
      FROM generate_series(1,14) n)))
    FROM products p LEFT JOIN product_traceability_profiles t ON t.tenant_id=p.tenant_id AND t.product_id=p.id
    WHERE p.tenant_id=tenant AND p.id=product),false)
$$;
--> statement-breakpoint
-- First profile INSERT/DELETE changes presence without an existing profile tuple to lock.
-- Advance only the parent MVCC tuple so a waiting repeatable-read finalizer retries its snapshot.
-- All product values (including updated_at) remain byte-for-byte unchanged.
CREATE FUNCTION receiving_profile_presence_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE products SET id=id WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id;
    RETURN NEW;
  END IF;
  UPDATE products SET id=id WHERE tenant_id=OLD.tenant_id AND id=OLD.product_id;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER receiving_profile_presence_changed AFTER INSERT OR DELETE ON product_traceability_profiles
FOR EACH ROW EXECUTE FUNCTION receiving_profile_presence_changed();
