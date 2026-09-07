ALTER TABLE "receiving_event_items" ADD COLUMN "exempt_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_exempt_receipt_valid" CHECK ("receiving_event_items"."exempt_receipt" IS NULL OR coalesce((
        jsonb_typeof("receiving_event_items"."exempt_receipt") = 'object'
        AND "receiving_event_items"."exempt_receipt" ?& ARRAY['evidenceUrl','tlcHandling','proposedTlc']
        AND ("receiving_event_items"."exempt_receipt" - ARRAY['evidenceUrl','tlcHandling','proposedTlc']) = '{}'::jsonb
        AND ("receiving_event_items"."exempt_receipt"->'evidenceUrl' = 'null'::jsonb OR (
          jsonb_typeof("receiving_event_items"."exempt_receipt"->'evidenceUrl') = 'string'
          AND octet_length("receiving_event_items"."exempt_receipt"->>'evidenceUrl') BETWEEN 1 AND 1024))
        AND ("receiving_event_items"."exempt_receipt"->'tlcHandling' = 'null'::jsonb OR (
          jsonb_typeof("receiving_event_items"."exempt_receipt"->'tlcHandling') = 'string'
          AND "receiving_event_items"."exempt_receipt"->>'tlcHandling' IN ('preserve_existing','assign_if_missing')))
        AND ("receiving_event_items"."exempt_receipt"->'proposedTlc' = 'null'::jsonb OR (
          jsonb_typeof("receiving_event_items"."exempt_receipt"->'proposedTlc') = 'string'
          AND length("receiving_event_items"."exempt_receipt"->>'proposedTlc') BETWEEN 1 AND 120
          AND "receiving_event_items"."exempt_receipt"->>'proposedTlc' = btrim("receiving_event_items"."exempt_receipt"->>'proposedTlc')
          AND "receiving_event_items"."exempt_receipt"->>'proposedTlc' !~ U&'[\0001-\001F\007F-\009F]'))
      ),false));
--> statement-breakpoint
-- Validation-only projection lets both versions share all original header, child,
-- product/profile, source, document and immutable-transition guarantees.
CREATE FUNCTION receiving_snapshot_v2_common(value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT value || jsonb_build_object(
    'snapshotVersion',1,
    'confirmation',((value->'confirmation')-'reviewedExemptLines') || '{"ruleVersion":"receiving-readiness-v2"}'::jsonb,
    'items',(SELECT jsonb_agg(item-'receiptBasis' ORDER BY position)
      FROM jsonb_array_elements(value->'items') WITH ORDINALITY AS items(item,position)))
$$;
--> statement-breakpoint
CREATE FUNCTION receiving_snapshot_v2_shape_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; basis jsonb; reviewed jsonb; expected jsonb;
  review_keys text[] := ARRAY['kind','reason','evidenceUrl','reviewedBy','reviewedAt'];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value->'snapshotVersion' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(value->'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'confirmation') IS DISTINCT FROM 'object'
    OR value->'confirmation'->'ruleVersion' IS DISTINCT FROM '"receiving-readiness-v3"'::jsonb
    OR jsonb_typeof(value->'confirmation'->'reviewedExemptLines') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  IF jsonb_array_length(value->'items') NOT BETWEEN 1 AND 100
    OR jsonb_array_length(value->'confirmation'->'reviewedExemptLines')>100
  THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'items') LOOP
    basis := item->'receiptBasis';
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(basis) IS DISTINCT FROM 'object'
      OR jsonb_typeof(basis->'kind') IS DISTINCT FROM 'string'
    THEN RETURN false; END IF;
    IF basis->>'kind'='ordinary' THEN
      IF basis <> '{"kind":"ordinary"}'::jsonb THEN RETURN false; END IF;
    ELSE
      IF NOT coalesce(basis->>'kind' IN ('exempt_existing_tlc','exempt_assigned_tlc'),false)
        OR NOT basis ?& review_keys
        OR jsonb_typeof(basis->'reason') IS DISTINCT FROM 'string'
        OR NOT receiving_text_v1_valid(basis->>'reason',2000)
        OR jsonb_typeof(basis->'evidenceUrl') IS DISTINCT FROM 'string'
        OR NOT coalesce(octet_length(basis->>'evidenceUrl') BETWEEN 1 AND 1024,false)
        OR jsonb_typeof(basis->'reviewedBy') IS DISTINCT FROM 'string'
        OR NOT receiving_text_v1_valid(basis->>'reviewedBy',128)
        OR jsonb_typeof(basis->'reviewedAt') IS DISTINCT FROM 'string'
        OR coalesce(basis->>'reviewedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      THEN RETURN false; END IF;
      IF basis->>'kind'='exempt_existing_tlc' THEN
        IF basis-review_keys <> '{}'::jsonb THEN RETURN false; END IF;
      ELSE
        IF basis->'receivedTlc' IS DISTINCT FROM 'null'::jsonb
          OR basis-(review_keys || ARRAY['receivedTlc']) <> '{}'::jsonb
        THEN RETURN false; END IF;
      END IF;
    END IF;
  END LOOP;
  reviewed := value->'confirmation'->'reviewedExemptLines';
  SELECT coalesce(jsonb_agg(items.item->'lineNo' ORDER BY items.position),'[]'::jsonb) INTO expected
    FROM jsonb_array_elements(value->'items') WITH ORDINALITY AS items(item,position)
    WHERE items.item->'receiptBasis'->>'kind'<>'ordinary';
  IF reviewed IS DISTINCT FROM expected THEN RETURN false; END IF;
  RETURN coalesce(receiving_snapshot_v1_shape_valid(receiving_snapshot_v2_common(value)),false);
END $$;
--> statement-breakpoint
-- A single header trigger retains the full v1 branch, original immutable/INSERT
-- denial and child-parent pulses. V2 adds only its saved-input receipt-path checks.
CREATE OR REPLACE FUNCTION receiving_header_finalization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  frozen := NEW.finalization_snapshot;
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
        OR l.source_locked_at IS NULL OR l.status <> 'active' OR l.product_id IS DISTINCT FROM i.product_id
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
              AND i.source_location_id=NEW.location_id
              AND i.source_reference_kind IS NULL AND i.source_reference_value IS NULL
              AND i.source_reference_location_id IS NULL
              AND l.assignment_basis='exempt_supplier_receipt'
              AND l.revision=1
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
