/** Append-only queue fairness and reconciliation capture corrections. */
export const PRINTING_FOLLOW_UP_MIGRATIONS = [
  `ALTER TABLE warehouse_pallet_sources ADD COLUMN production_delivery_json TEXT CHECK(production_delivery_json IS NULL OR json_valid(production_delivery_json));`,
  `ALTER TABLE warehouse_pallet_sources ADD COLUMN production_delivery_acked_sequence INTEGER NOT NULL DEFAULT 0 CHECK(production_delivery_acked_sequence>=0);`,
  `ALTER TABLE unit_label_facts ADD COLUMN last_tried_at TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE warehouse_pallet_events ADD COLUMN last_tried_at TEXT NOT NULL DEFAULT '';`,
  `DROP TRIGGER IF EXISTS capture_unit_label_facts;`,
  `CREATE TRIGGER IF NOT EXISTS capture_unit_label_facts AFTER INSERT ON outbox WHEN NEW.verdict='ok' AND COALESCE(NEW.replay_origin,0)=0 AND length(NEW.code_hash)=64 AND NEW.code_hash NOT GLOB '*[^0-9a-f]*'
  BEGIN
   INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,canonical_raw,context_json,fields_json)
   SELECT COALESCE((SELECT active_hash FROM station_device_recovery WHERE id=1),
      (SELECT credential_ownership FROM product_label_accept_commands WHERE shift_id=NEW.shift_id AND code_hash=NEW.code_hash AND accepted_at=NEW.scanned_at LIMIT 1),''),
     NEW.shift_id,NEW.code_hash,NEW.scanned_at,'',
     json_object('productName',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.product.name') ELSE p.name END),'productPrintName',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.product.printName') ELSE p.print_name END),'gtin14',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.product.gtin14') ELSE p.gtin14 END),'egaisCode',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.product.egaisCode') ELSE p.egais_code END),
       'shelfLifeDays',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.product.shelfLifeDays') ELSE p.shelf_life_days END),'productionDate',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.shift.productionDate') ELSE s.production_date END),'acceptedLocalDate',date(NEW.scanned_at,'localtime'),
       'shiftNumber',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.shift.number') ELSE s.number END),'counterpartyName',(CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.shift.counterpartyName') ELSE s.counterparty_name END),'operatorName',(SELECT name FROM operators_mirror WHERE operator_id=NEW.operator_id AND COALESCE((SELECT value FROM station_meta WHERE key='operators_slot'),'a')<>'b'
         UNION ALL SELECT name FROM operators_mirror_b WHERE operator_id=NEW.operator_id AND COALESCE((SELECT value FROM station_meta WHERE key='operators_slot'),'a')='b' LIMIT 1)),
     (SELECT json_set(json_extract(acceptance_json,'$.fields'),'$."km.code"','') FROM product_label_accept_commands WHERE shift_id=NEW.shift_id AND code_hash=NEW.code_hash AND accepted_at=NEW.scanned_at LIMIT 1)
    FROM shift_mirror s LEFT JOIN product_mirror p ON p.id=s.product_id WHERE s.id=NEW.shift_id AND (CASE WHEN json_valid(s.execution_scope_json) AND json_type(s.execution_scope_json,'$.product')='object' THEN json_extract(s.execution_scope_json,'$.product.gtin14') ELSE p.gtin14 END)=NEW.gtin14
    ON CONFLICT DO NOTHING;
   INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,canonical_raw,fields_json)
    SELECT credential_ownership,shift_id,code_hash,accepted_at,'',json_set(json_extract(acceptance_json,'$.fields'),'$."km.code"','') FROM product_label_accept_commands
     WHERE shift_id=NEW.shift_id AND code_hash=NEW.code_hash AND accepted_at=NEW.scanned_at
    ON CONFLICT DO NOTHING;
  END;`,
];
