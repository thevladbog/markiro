-- Reuse Receiving's exact tenant-owned facts and normalization. These wrappers
-- only adapt the Transformation envelope; they do not rebuild historical facts.
CREATE FUNCTION transformation_product_v2_matches(value jsonb, tenant text, product uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_typeof(value) = 'object'
    AND value = jsonb_build_object('id',product,'description',value->'description',
      'coverage',value->'coverage','kdes',value->'kdes')
    AND jsonb_typeof(value->'description') = 'string'
    AND receiving_text_v1_valid(value->>'description',2000)
    AND receiving_product_snapshot_matches(jsonb_build_object(
      'productDescription',value->'kdes','coverage',value->'coverage'),tenant,product),
    false)
$$;
--> statement-breakpoint
CREATE FUNCTION transformation_location_v2_matches(value jsonb, tenant text, location uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_typeof(value) = 'object'
    AND value = jsonb_build_object('id',location,'description',value->'description','kdes',value->'kdes')
    AND jsonb_typeof(value->'description') = 'string'
    AND receiving_text_v1_valid(value->>'description',2000)
    AND receiving_location_snapshot_matches(value->'kdes',tenant,location),
    false)
$$;
--> statement-breakpoint
CREATE FUNCTION transformation_snapshot_v2_matches(
  s jsonb, tenant text, event uuid, processor uuid, previous uuid
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE x record; j jsonb; source jsonb; projected jsonb;
BEGIN
  IF jsonb_typeof(s) IS DISTINCT FROM 'object'
    OR s->'snapshotVersion' IS DISTINCT FROM '2'::jsonb
    OR NOT s ?& ARRAY['snapshotVersion','eventId','eventNumber','revision','eventDate','timeZone',
      'processor','reason','reasonNote','notes','inputs','outputs','documents','finalizedBy','finalizedAt']
    OR (s-ARRAY['snapshotVersion','eventId','eventNumber','revision','previousRevisionId',
      'eventDate','timeZone','processor','reason','reasonNote','notes','inputs','outputs','documents',
      'finalizedBy','finalizedAt']) IS DISTINCT FROM '{}'::jsonb
    OR (previous IS NULL AND s ? 'previousRevisionId')
    OR (previous IS NOT NULL AND s->'previousRevisionId' IS DISTINCT FROM to_jsonb(previous))
    OR jsonb_typeof(s->'inputs') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'outputs') IS DISTINCT FROM 'array'
    OR transformation_location_v2_matches(s->'processor',tenant,processor) IS DISTINCT FROM true
  THEN RETURN false; END IF;

  FOR x IN
    SELECT i.kind, i.line_no, CASE WHEN i.kind='ftl_lot' THEN l.product_id ELSE i.product_id END AS product_id,
      CASE WHEN i.kind='ftl_lot' THEN coalesce(l.source_location_id,l.source_reference_location_id)
        ELSE i.source_location_id END AS location_id, s->'inputs'->(i.line_no-1) AS value, false AS output
      FROM transformation_event_inputs i LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
      WHERE i.tenant_id=tenant AND i.event_id=event
    UNION ALL
    SELECT NULL, o.line_no, o.product_id, processor, s->'outputs'->(o.line_no-1), true
      FROM transformation_event_outputs o WHERE o.tenant_id=tenant AND o.event_id=event
  LOOP
    j:=x.value;
    IF jsonb_typeof(j) IS DISTINCT FROM 'object'
      OR transformation_product_v2_matches(j->'product',tenant,x.product_id) IS DISTINCT FROM true
    THEN RETURN false; END IF;
    -- Compare exact field sets as well as required presence. The predecessor
    -- already binds each field to the typed native lines and immutable lot IDs.
    IF x.output THEN
      projected:=jsonb_build_object('lineNo',j->'lineNo','lotId',j->'lotId','product',j->'product',
        'tlc',j->'tlc','source',j->'source','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure');
    ELSIF x.kind='ftl_lot' THEN
      projected:=jsonb_build_object('kind',j->'kind','lineNo',j->'lineNo','lotId',j->'lotId','product',j->'product',
        'tlc',j->'tlc','source',j->'source','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure');
    ELSE
      projected:=jsonb_build_object('kind',j->'kind','lineNo',j->'lineNo','product',j->'product',
        'reference',j->'reference','source',j->'source','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure');
    END IF;
    IF j IS DISTINCT FROM projected THEN RETURN false; END IF;
    source:=j->'source';
    IF source->'kind'='"location"'::jsonb THEN
      projected:=source-'kind';
    ELSIF NOT x.output AND x.kind='ftl_lot' AND source->'kind'='"reference"'::jsonb
      AND source->'referenceKind'='"web_url"'::jsonb
      AND jsonb_typeof(source->'referenceValue')='string'
      AND receiving_text_v1_valid(source->>'referenceValue',1024)
    THEN projected:=source-ARRAY['kind','referenceKind','referenceValue'];
    ELSE RETURN false;
    END IF;
    IF transformation_location_v2_matches(projected,tenant,x.location_id) IS DISTINCT FROM true
    THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
-- Patch only three unique predecessor expressions, failing closed on any anchor
-- or revision/status drift. All earlier typed-line, coverage, output, document,
-- genealogy, revision and immutability guards remain in place verbatim.
DO $migration$
DECLARE definition text; old_parts text[]; new_parts text[]; i integer; anchor text;
BEGIN
  -- Exact prosrc from 0131 with only 0132's two reviewed substitutions.
  -- pg_get_functiondef's outer formatting can vary; the stored PL/pgSQL body
  -- cannot drift (even outside our replacement anchors) unnoticed.
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid='transformation_finalization_guard()'::regprocedure)
      IS DISTINCT FROM 'e1cf68af3638b778cc4cb4dd9b393d33'
  THEN RAISE EXCEPTION 'Transformation V2 predecessor body shape changed'; END IF;
  definition:=pg_get_functiondef('transformation_finalization_guard()'::regprocedure);
  FOREACH anchor IN ARRAY ARRAY[
    '(s->''revision'') IS DISTINCT FROM to_jsonb(e.revision)',
    'IF NEW.status<>''finalized'' THEN RETURN NULL; END IF;'
  ] LOOP
    IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
    THEN RAISE EXCEPTION 'Transformation V2 predecessor revision/status guard shape changed'; END IF;
  END LOOP;
  old_parts:=ARRAY[
    '(s->''snapshotVersion'') IS DISTINCT FROM ''1''::jsonb',
    '(j->''source'')-''description'' ORDER BY n',
    '  RETURN NULL;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN'
  ];
  new_parts:=ARRAY[
    '((s->''snapshotVersion'') IS DISTINCT FROM ''1''::jsonb AND (s->''snapshotVersion'') IS DISTINCT FROM ''2''::jsonb)',
    '(CASE WHEN s->''snapshotVersion''=''2''::jsonb THEN (j->''source'')-''kdes'' ELSE j->''source'' END)-''description'' ORDER BY n',
    '  IF s->''snapshotVersion''=''2''::jsonb AND
    transformation_snapshot_v2_matches(s,e.tenant_id,e.id,e.location_id,e.previous_revision_id) IS DISTINCT FROM true
  THEN RAISE EXCEPTION ''Transformation structured snapshot mismatch'' USING ERRCODE=''23514''; END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN'
  ];
  FOR i IN 1..array_length(old_parts,1) LOOP
    IF (length(definition)-length(replace(definition,old_parts[i],'')))/length(old_parts[i])<>1
    THEN RAISE EXCEPTION 'Transformation V2 predecessor anchor % shape changed',i; END IF;
    definition:=replace(definition,old_parts[i],new_parts[i]);
  END LOOP;
  EXECUTE definition;
END $migration$;
