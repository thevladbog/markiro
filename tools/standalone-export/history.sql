-- Streaming final cloud report facts. All selections share one tenant-scoped snapshot.
-- psql FETCH_COUNT bounds libpq result buffering; no temporary tables are needed.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

WITH RECURSIVE
params AS (
  SELECT transaction_timestamp() AS exported_at,
    coalesce(nullif(:'history_since', '')::date, (transaction_timestamp() - interval '12 months')::date) AS since
),
window_shifts AS (
  SELECT id FROM shifts
  WHERE tenant_id = :'tenant_id' AND status = 'closed'
    AND coalesce(closed_at, created_at) >= (SELECT since FROM params)
),
-- Undirected pack dependencies: a warehouse pallet takes ALL its boxes,
-- including shifts outside the report window, and their pack dependencies.
edges(a_kind, a_id, b_kind, b_id) AS (
  SELECT 'shift', shift_id, 'box', id FROM boxes WHERE tenant_id = :'tenant_id'
  UNION ALL SELECT 'box', id, 'shift', shift_id FROM boxes WHERE tenant_id = :'tenant_id'
  UNION ALL SELECT 'box', id, 'pallet', pallet_id FROM boxes WHERE tenant_id = :'tenant_id' AND pallet_id IS NOT NULL
  UNION ALL SELECT 'pallet', pallet_id, 'box', id FROM boxes WHERE tenant_id = :'tenant_id' AND pallet_id IS NOT NULL
  UNION ALL SELECT 'shift', shift_id, 'pallet', id FROM pallets WHERE tenant_id = :'tenant_id' AND shift_id IS NOT NULL
  UNION ALL SELECT 'pallet', id, 'shift', shift_id FROM pallets WHERE tenant_id = :'tenant_id' AND shift_id IS NOT NULL
),
closure(kind, id) AS (
  SELECT 'shift'::text, id FROM window_shifts
  UNION
  SELECT e.b_kind, e.b_id FROM closure c JOIN edges e ON e.a_kind = c.kind AND e.a_id = c.id
),
selected_shifts AS (
  SELECT s.* FROM shifts s JOIN closure d ON d.kind = 'shift' AND d.id = s.id WHERE s.tenant_id = :'tenant_id'
),
selected_boxes AS (
  SELECT b.* FROM boxes b JOIN closure d ON d.kind = 'box' AND d.id = b.id WHERE b.tenant_id = :'tenant_id'
),
selected_pallets AS (
  SELECT p.* FROM pallets p JOIN closure d ON d.kind = 'pallet' AND d.id = p.id WHERE p.tenant_id = :'tenant_id'
),
-- Exactly the cloud report's four-column canonical join. A missing row is a
-- refusal, never an inner join that silently loses an owner.
owners AS (
  SELECT r.*, c.canonical_raw, c.gtin14, c.serial, s.number_month_key, s.number_seq, s.created_from
  FROM code_registry r
  LEFT JOIN codes c ON c.tenant_id = r.tenant_id AND c.code_hash = r.code_hash
    AND c.shift_id = r.shift_id AND c.scanned_at = r.scanned_at
  LEFT JOIN shifts s ON s.tenant_id = r.tenant_id AND s.id = r.shift_id
  WHERE r.tenant_id = :'tenant_id'
),
last_close AS (SELECT max(closed_at) AS at FROM shifts WHERE tenant_id = :'tenant_id'),
guard AS (
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM organization o JOIN org_profiles p ON p.tenant_id = o.id
      WHERE o.id = :'tenant_id' AND p.gln IS NOT NULL) THEN 'source_missing'
    WHEN EXISTS (SELECT 1 FROM shifts WHERE tenant_id = :'tenant_id' AND status = 'active')
      OR EXISTS (SELECT 1 FROM station_devices d, last_close
        WHERE d.tenant_id = :'tenant_id' AND d.revoked_at IS NULL AND last_close.at IS NOT NULL
          AND (d.last_seen_at IS NULL OR d.last_seen_at < last_close.at)
          AND EXISTS (SELECT 1 FROM sscc_blocks b WHERE b.tenant_id = d.tenant_id AND b.device_id = d.id AND b.revoked_at IS NULL)) THEN 'cloud_not_clean'
    WHEN EXISTS (SELECT 1 FROM owners WHERE canonical_raw IS NULL OR canonical_raw = '' OR number_month_key IS NULL) THEN 'missing_canonical'
    WHEN EXISTS (SELECT 1 FROM selected_shifts WHERE status <> 'closed') THEN 'dependency_not_closed'
    WHEN EXISTS (SELECT 1 FROM box_items WHERE tenant_id = :'tenant_id' AND displaced_at IS NULL AND removed_at IS NULL
      GROUP BY code_hash HAVING count(*) > 1) THEN 'ambiguous_owner_box'
    ELSE NULL END AS problem
),
records(rank, key, record) AS (
  SELECT 0, '', CASE WHEN g.problem IS NOT NULL THEN json_build_object('type', 'error', 'value', g.problem)
    ELSE json_build_object('type', 'metadata', 'value', json_build_object(
      'source', (SELECT json_build_object('tenantId', id, 'tenantName', name) FROM organization WHERE id = :'tenant_id'),
      'organization', (SELECT json_build_object('name', o.name, 'inn', p.inn, 'gln', p.gln, 'timeZone', p.time_zone)
        FROM organization o JOIN org_profiles p ON p.tenant_id = o.id WHERE o.id = :'tenant_id'),
      'clean', true, 'exportedAt', (SELECT exported_at FROM params), 'since', (SELECT since FROM params))) END FROM guard g
  UNION ALL
  SELECT 1, s.id::text, json_build_object('type', 'shifts', 'value', json_build_object(
    'id', s.id,
    'number', s.number_month_key || '-' || lpad(s.number_seq::text, greatest(3, length(s.number_seq::text)), '0') || CASE WHEN s.created_from = 'station' THEN '/S' ELSE '' END,
    'mode', s.mode, 'productionDate', s.production_date, 'plannedDate', s.planned_date,
    'openedAt', s.opened_at, 'closedAt', s.closed_at, 'productId', s.product_id,
    'productName', p.name, 'gtin14', p.gtin14::text, 'lineId', s.line_id, 'lineName', l.name,
    'palletsEnabled', s.pallets_enabled, 'inWindow', EXISTS (SELECT 1 FROM window_shifts w WHERE w.id = s.id),
    'createdFrom', s.created_from, 'numberMonthKey', s.number_month_key, 'numberSeq', s.number_seq,
    'shelfLifeDays', p.shelf_life_days,
    'createdAt', s.created_at, 'plannedQty', s.planned_qty, 'boxCapacity', s.box_capacity, 'palletBoxCapacity', s.pallet_box_capacity,
    'counterpartyId', s.counterparty_id, 'counterpartyName', cp.name, 'closeReason', s.close_reason))
  FROM selected_shifts s
  LEFT JOIN products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
  LEFT JOIN lines l ON l.tenant_id = s.tenant_id AND l.id = s.line_id
  LEFT JOIN counterparties cp ON cp.tenant_id = s.tenant_id AND cp.id = s.counterparty_id
  UNION ALL
  SELECT 2, r.shift_id::text || '/' || r.scanned_at::text || '/' || r.code_hash, json_build_object('type', 'codes', 'value', json_build_object(
    'shiftId', r.shift_id, 'hash', r.code_hash, 'canonical', r.canonical_raw, 'scannedAt', r.scanned_at,
    'gtin14', r.gtin14::text, 'serial', r.serial, 'flatOnly', false))
  FROM owners r JOIN selected_shifts s ON s.id = r.shift_id
  UNION ALL
  -- Reprocessing occurrences belong to flat formats only. The cloud keeps an
  -- authoritative current owner in preference to a repeat of the same hash.
  SELECT 2, r.shift_id::text || '/' || r.scanned_at::text || '/' || r.code_hash, json_build_object('type', 'codes', 'value', json_build_object(
    'shiftId', r.shift_id, 'hash', r.code_hash, 'canonical', r.canonical_raw, 'scannedAt', r.scanned_at,
    'gtin14', NULL, 'serial', NULL, 'flatOnly', true))
  FROM validation_code_reprocessings r JOIN selected_shifts s ON s.id = r.shift_id
  WHERE r.tenant_id = :'tenant_id' AND NOT EXISTS (SELECT 1 FROM owners o WHERE o.shift_id = r.shift_id AND o.code_hash = r.code_hash)
  UNION ALL
  SELECT 3, b.id::text, json_build_object('type', 'boxes', 'value', json_build_object(
    'id', b.id, 'shiftId', b.shift_id, 'sscc', b.sscc, 'openedAt', b.opened_at,
    'closedAt', b.closed_at, 'disassembledAt', b.disassembled_at, 'palletId', b.pallet_id)) FROM selected_boxes b
  UNION ALL
  SELECT 4, i.box_id::text || '/' || i.code_hash, json_build_object('type', 'items', 'value', json_build_object(
    'boxId', i.box_id, 'hash', i.code_hash, 'addedAt', i.added_at))
  FROM box_items i JOIN selected_boxes b ON b.tenant_id = i.tenant_id AND b.id = i.box_id
  WHERE i.tenant_id = :'tenant_id' AND i.displaced_at IS NULL AND i.removed_at IS NULL
  UNION ALL
  SELECT 5, p.id::text, json_build_object('type', 'pallets', 'value', json_build_object(
    'id', p.id, 'shiftId', p.shift_id, 'kind', p.kind, 'productId', p.product_id, 'sscc', p.sscc,
    'productName', product.name, 'gtin14', product.gtin14::text, 'shelfLifeDays', product.shelf_life_days,
    'openedAt', p.opened_at, 'closedAt', p.closed_at, 'disassembledAt', p.disassembled_at)) FROM selected_pallets p
  LEFT JOIN shifts ps ON ps.tenant_id = p.tenant_id AND ps.id = p.shift_id
  LEFT JOIN products product ON product.tenant_id = p.tenant_id AND product.id = coalesce(p.product_id, ps.product_id)
  UNION ALL
  -- Deliberately no window join: every current owner prevents duplicate reuse.
  SELECT 6, o.code_hash, json_build_object('type', 'owners', 'value', json_build_object(
    'hash', o.code_hash, 'shiftId', o.shift_id,
    'number', o.number_month_key || '-' || lpad(o.number_seq::text, greatest(3, length(o.number_seq::text)), '0') || CASE WHEN o.created_from = 'station' THEN '/S' ELSE '' END,
    'scannedAt', o.scanned_at,
    'boxId', (SELECT i.box_id FROM box_items i WHERE i.tenant_id = o.tenant_id AND i.code_hash = o.code_hash AND i.displaced_at IS NULL AND i.removed_at IS NULL LIMIT 1))) FROM owners o
)
SELECT record FROM records ORDER BY rank, key;

COMMIT;
