-- One cloud tenant as one JSON document, for the standalone import (pilot
-- spec §8.7). Run by `cli.mjs` through psql against a RESTORED COPY of the
-- cloud database: `psql -X -q -A -t -v ON_ERROR_STOP=1 -v tenant_id=<id> -f export.sql`.
-- One read-only REPEATABLE READ transaction, so every table is read at one
-- snapshot. Every query is scoped to :'tenant_id', except one that looks at
-- the other tenants of the database, read-only, for the serials they hold
-- under this tenant's prefixes ('otherTenantsSscc'): the prefixes of its
-- counters and blocks, of its organization's GLN and of its counterparties'
-- GLNs, whether or not this tenant ever issued under them. The output holds badge
-- codes in clear text: cli.mjs reads it from psql's stdout into memory and
-- never writes it anywhere. It prints every key every time (an empty list
-- is [], never absent): transform.mjs refuses output that lacks one.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH prefixes AS (
  SELECT issuer_prefix::text AS issuer_prefix FROM sscc_counters WHERE tenant_id = :'tenant_id'
  UNION
  SELECT issuer_prefix::text FROM sscc_blocks WHERE tenant_id = :'tenant_id'
  UNION
  SELECT substr(btrim(gln), 1, 9) FROM org_profiles
  WHERE tenant_id = :'tenant_id' AND btrim(gln) ~ '^[0-9]{13}$'
  UNION
  SELECT substr(btrim(gln), 1, 9) FROM counterparties
  WHERE tenant_id = :'tenant_id' AND btrim(gln) ~ '^[0-9]{13}$'
),
printed AS (
  SELECT substr(sscc, 2, 9) AS issuer_prefix, substr(sscc, 1, 1)::int AS extension,
    substr(sscc, 11, 7)::bigint AS serial
  FROM boxes WHERE tenant_id = :'tenant_id' AND sscc ~ '^[0-9]{18}$'
  UNION ALL
  SELECT substr(sscc, 2, 9), substr(sscc, 1, 1)::int, substr(sscc, 11, 7)::bigint
  FROM pallets WHERE tenant_id = :'tenant_id' AND sscc ~ '^[0-9]{18}$'
),
last_close AS (
  SELECT max(closed_at) AS at FROM shifts WHERE tenant_id = :'tenant_id'
)
SELECT json_build_object(
  'formatVersion', 1,
  'tenant', (SELECT json_build_object('id', o.id, 'name', o.name)
    FROM organization o WHERE o.id = :'tenant_id'),
  'orgProfile', (SELECT json_build_object(
      'gln', p.gln, 'inn', p.inn, 'gs1Prefixes', to_json(p.gs1_prefixes), 'timeZone', p.time_zone,
      'defaultBoxTemplateId', p.default_box_label_template_id,
      'defaultPalletTemplateId', p.default_pallet_label_template_id)
    FROM org_profiles p WHERE p.tenant_id = :'tenant_id'),
  'badgeSalt', (SELECT salt FROM employee_badge_salts WHERE tenant_id = :'tenant_id'),
  'lines', coalesce((SELECT json_agg(json_build_object('id', l.id, 'name', l.name)
      ORDER BY l.created_at, l.id)
    FROM lines l WHERE l.tenant_id = :'tenant_id'), '[]'::json),
  'counterparties', coalesce((SELECT json_agg(json_build_object(
      'id', c.id, 'name', c.name, 'inn', c.inn, 'gln', c.gln,
      'gs1Prefixes', to_json(c.gs1_prefixes),
      'hasNotes', coalesce(btrim(c.notes), '') <> '') ORDER BY c.created_at, c.id)
    FROM counterparties c WHERE c.tenant_id = :'tenant_id'), '[]'::json),
  'templates', coalesce((SELECT json_agg(json_build_object(
      'id', t.id, 'name', t.name, 'purpose', t.purpose, 'enabled', t.enabled,
      'format', t.format,
      'chzProductGroupCodes', to_json(t.chz_product_group_codes), 'spec', t.spec)
      ORDER BY t.created_at, t.id)
    FROM label_templates t WHERE t.tenant_id = :'tenant_id'), '[]'::json),
  'boxDefaults', coalesce((SELECT json_agg(json_build_object(
      'chzProductGroupCode', d.chz_product_group_code, 'templateId', d.template_id)
      ORDER BY d.chz_product_group_code)
    FROM org_box_label_template_defaults d WHERE d.tenant_id = :'tenant_id'), '[]'::json),
  'palletDefaults', coalesce((SELECT json_agg(json_build_object(
      'chzProductGroupCode', d.chz_product_group_code, 'templateId', d.template_id)
      ORDER BY d.chz_product_group_code)
    FROM org_pallet_label_template_defaults d WHERE d.tenant_id = :'tenant_id'), '[]'::json),
  'products', coalesce((SELECT json_agg(json_build_object(
      'id', p.id, 'gtin14', p.gtin14::text, 'name', p.name, 'printName', p.print_name,
      'chzProductGroupCode', p.chz_product_group_code, 'boxCapacity', p.box_capacity,
      'palletBoxCapacity', p.pallet_box_capacity, 'shelfLifeDays', p.shelf_life_days,
      'archived', p.archived, 'defaultLabelTemplateId', p.default_label_template_id,
      'lost', to_json(array_remove(ARRAY[
        CASE WHEN p.default_counterparty_id IS NOT NULL THEN 'defaultCounterparty' END,
        CASE WHEN p.egais_code IS NOT NULL THEN 'egaisCode' END,
        CASE WHEN p.external_ref IS NOT NULL THEN 'externalRef' END,
        CASE WHEN EXISTS (SELECT 1 FROM product_images i
          WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id) THEN 'photo' END,
        CASE WHEN p.unit_price IS NOT NULL THEN 'price' END], NULL)))
      ORDER BY p.created_at, p.id)
    FROM products p WHERE p.tenant_id = :'tenant_id'), '[]'::json),
  'operators', coalesce((SELECT json_agg(json_build_object(
      'id', oc.employee_id, 'login', oc.login, 'pinHash', oc.pin_hash,
      'credentialActive', oc.active, 'employeeStatus', e.status,
      'fullName', e.full_name, 'role', e.role) ORDER BY oc.login, oc.employee_id)
    FROM operator_credentials oc
    JOIN employees e ON e.tenant_id = oc.tenant_id AND e.id = oc.employee_id
    WHERE oc.tenant_id = :'tenant_id'), '[]'::json),
  'badges', coalesce((SELECT json_agg(json_build_object(
      'id', b.id, 'operatorId', b.employee_id, 'badgeCode', b.badge_code,
      'badgeHash', b.badge_hash, 'label', b.label) ORDER BY b.issued_at, b.id)
    FROM employee_badges b
    WHERE b.tenant_id = :'tenant_id' AND b.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM operator_credentials oc
        WHERE oc.tenant_id = b.tenant_id AND oc.employee_id = b.employee_id)), '[]'::json),
  'nonOperatorBadges', (SELECT count(*) FROM employee_badges b
    WHERE b.tenant_id = :'tenant_id' AND b.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM operator_credentials oc
        WHERE oc.tenant_id = b.tenant_id AND oc.employee_id = b.employee_id)),
  'ssccCounters', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', s.issuer_prefix::text, 'extension', s.extension_digit,
      'nextSerial', s.next_serial) ORDER BY s.issuer_prefix, s.extension_digit)
    FROM sscc_counters s WHERE s.tenant_id = :'tenant_id'), '[]'::json),
  'ssccBlocks', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', g.issuer_prefix, 'extension', g.extension_digit,
      'maxToSerial', g.max_to, 'maxConsumedThrough', g.max_consumed)
      ORDER BY g.issuer_prefix, g.extension_digit)
    FROM (SELECT issuer_prefix::text AS issuer_prefix, extension_digit,
        max(to_serial) AS max_to, max(consumed_through_serial) AS max_consumed
      FROM sscc_blocks WHERE tenant_id = :'tenant_id'
      GROUP BY issuer_prefix, extension_digit) g), '[]'::json),
  -- Every SSCC this tenant printed, under any prefix: boxes printed before
  -- blocks existed have no counter or block row to name their prefix.
  'ssccPrinted', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', g.issuer_prefix, 'extension', g.extension, 'maxSerial', g.max_serial)
      ORDER BY g.issuer_prefix, g.extension)
    FROM (SELECT issuer_prefix, extension, max(serial) AS max_serial FROM printed
      WHERE extension IN (0, 1)
      GROUP BY issuer_prefix, extension) g), '[]'::json),
  'shiftNumberCounters', coalesce((SELECT json_agg(json_build_object(
      'monthKey', n.month_key, 'lastSeq', n.last_seq) ORDER BY n.month_key)
    FROM shift_number_counters n WHERE n.tenant_id = :'tenant_id'), '[]'::json),
  -- The highest number each month has handed out, to check against the
  -- counters above: a counter behind its shifts would repeat a number.
  'shiftNumberMaxima', coalesce((SELECT json_agg(json_build_object(
      'monthKey', g.month_key, 'maxSeq', g.max_seq) ORDER BY g.month_key)
    FROM (SELECT number_month_key AS month_key, max(number_seq) AS max_seq
      FROM shifts WHERE tenant_id = :'tenant_id' GROUP BY number_month_key) g), '[]'::json),
  -- Read-only look at the OTHER tenants of this database: the highest serial
  -- any of them holds (counter, block or printed box/pallet) under a 9-digit
  -- prefix of this tenant. Nothing of theirs but prefix, extension and a
  -- serial leaves the query; under the organization's prefix it stops the
  -- export (transform.mjs, sscc_prefix_shared), and the file never holds it.
  'otherTenantsSscc', coalesce((SELECT json_agg(json_build_object(
      'issuerPrefix', g.issuer_prefix, 'extension', g.extension, 'maxSerial', g.max_serial)
      ORDER BY g.issuer_prefix, g.extension)
    FROM (SELECT f.issuer_prefix, f.extension, max(f.serial) AS max_serial FROM (
        SELECT issuer_prefix::text AS issuer_prefix, extension_digit AS extension,
          next_serial - 1 AS serial
        FROM sscc_counters WHERE tenant_id <> :'tenant_id'
        UNION ALL
        SELECT issuer_prefix::text, extension_digit, to_serial
        FROM sscc_blocks WHERE tenant_id <> :'tenant_id'
        UNION ALL
        SELECT substr(sscc, 2, 9), substr(sscc, 1, 1)::int, substr(sscc, 11, 7)::bigint
        FROM boxes WHERE tenant_id <> :'tenant_id' AND sscc ~ '^[0-9]{18}$'
        UNION ALL
        SELECT substr(sscc, 2, 9), substr(sscc, 1, 1)::int, substr(sscc, 11, 7)::bigint
        FROM pallets WHERE tenant_id <> :'tenant_id' AND sscc ~ '^[0-9]{18}$'
      ) f
      WHERE f.extension IN (0, 1) AND f.issuer_prefix IN (SELECT issuer_prefix FROM prefixes)
      GROUP BY f.issuer_prefix, f.extension) g), '[]'::json),
  'activeShifts', coalesce((SELECT json_agg(json_build_object(
      'monthKey', s.number_month_key, 'seq', s.number_seq, 'createdFrom', s.created_from)
      ORDER BY s.number_month_key, s.number_seq, s.id)
    FROM shifts s WHERE s.tenant_id = :'tenant_id' AND s.status = 'active'), '[]'::json),
  'staleDevices', coalesce((SELECT json_agg(json_build_object('id', d.id, 'name', d.name)
      ORDER BY d.name, d.id)
    FROM station_devices d, last_close
    WHERE d.tenant_id = :'tenant_id' AND d.revoked_at IS NULL AND last_close.at IS NOT NULL
      AND (d.last_seen_at IS NULL OR d.last_seen_at < last_close.at)
      AND EXISTS (SELECT 1 FROM sscc_blocks b
        WHERE b.tenant_id = d.tenant_id AND b.device_id = d.id AND b.revoked_at IS NULL)), '[]'::json),
  'counterpartyIssuedShifts', (SELECT count(*) FROM shifts
    WHERE tenant_id = :'tenant_id' AND sscc_issuer_counterparty_id IS NOT NULL),
  'plannedShifts', (SELECT count(*) FROM shifts
    WHERE tenant_id = :'tenant_id' AND status = 'planned'),
  -- The A4 pallet sheet defaults (the organization's and its categories'):
  -- the sheets stay in the cloud, so the export only counts what is lost.
  'palletSheetDefaults', (SELECT count(*) FROM org_profiles p
      WHERE p.tenant_id = :'tenant_id' AND p.default_pallet_sheet_template_id IS NOT NULL)
    + (SELECT count(*) FROM org_pallet_sheet_template_defaults d
      WHERE d.tenant_id = :'tenant_id')
);

COMMIT;
