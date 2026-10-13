/** Additive guards join the journals without rewriting their historical records. */
const relatedOwners = (owner: string) => `${owner} OR j.owner IN (
  SELECT related.credential_hash FROM station_device_owners related
  JOIN station_device_owners original ON original.owner_json=related.owner_json
  WHERE original.credential_hash=${owner})`;
const syncSettings = `INSERT INTO warehouse_pallet_settings(owner,reason,session_id,session_status,sent_count,template_choices_json)
  VALUES(NEW.owner,json_extract(NEW.session_json,'$.reason'),NEW.session_id,'active',0,
    json_object(json_extract(NEW.session_json,'$.palletTemplate.kind'),json(json_extract(NEW.session_json,'$.palletTemplate'))))
  ON CONFLICT(owner) DO UPDATE SET reason=excluded.reason,session_id=excluded.session_id,session_status='active',
    sent_count=CASE WHEN warehouse_pallet_settings.session_id=excluded.session_id THEN warehouse_pallet_settings.sent_count ELSE 0 END,
    template_choices_json=json_set(warehouse_pallet_settings.template_choices_json,
      '$.'||json_extract(NEW.session_json,'$.palletTemplate.kind'),json(json_extract(NEW.session_json,'$.palletTemplate')));`;
export const UNIFIED_REPRINT_MIGRATIONS = [
  ...["INSERT", "UPDATE OF session_json,status"].map(
    (event, index) =>
      `CREATE TRIGGER IF NOT EXISTS warehouse_unified_settings_${index} AFTER ${event} ON warehouse_reprint_sessions
     WHEN json_extract(NEW.session_json,'$.palletTemplate.kind') IN ('a4','thermal')
       AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_session_closures WHERE owner=NEW.owner AND session_id=NEW.session_id)
     BEGIN ${syncSettings} END;`,
  ),
  `CREATE TRIGGER IF NOT EXISTS warehouse_unified_close_guard BEFORE INSERT ON warehouse_reprint_session_closures
   WHEN NOT EXISTS(SELECT 1 FROM warehouse_reprint_session_closures WHERE owner=NEW.owner AND session_id=NEW.session_id) BEGIN
     SELECT RAISE(ABORT,'WAREHOUSE_RECOVERY_REQUIRED') WHERE EXISTS(
       SELECT 1 FROM warehouse_pallet_jobs j WHERE (j.owner=${relatedOwners("NEW.owner")})
       AND j.state IN ('prepared','sending','delivery_unknown','failed_before_send'));
   END;`,
  `CREATE TRIGGER IF NOT EXISTS warehouse_unified_settings_closed AFTER INSERT ON warehouse_reprint_session_closures BEGIN
     UPDATE warehouse_pallet_settings SET session_status='finished' WHERE owner=NEW.owner AND session_id=NEW.session_id;
   END;`,
  `CREATE TRIGGER IF NOT EXISTS warehouse_unified_unit_prepare_guard BEFORE INSERT ON warehouse_reprint_commands
   WHEN NEW.kind='prepare' BEGIN
     SELECT RAISE(ABORT,'WAREHOUSE_RECOVERY_REQUIRED') WHERE EXISTS(
       SELECT 1 FROM warehouse_pallet_jobs j WHERE (j.owner=${relatedOwners("NEW.owner")})
       AND j.state IN ('prepared','sending','delivery_unknown','failed_before_send'));
   END;`,
  `CREATE TRIGGER IF NOT EXISTS warehouse_unified_pallet_prepare_guard BEFORE INSERT ON warehouse_pallet_jobs
   WHEN NEW.protocol='warehouse-unified-reprint-v3' BEGIN
     SELECT RAISE(ABORT,'WAREHOUSE_RECOVERY_REQUIRED') WHERE EXISTS(
       SELECT 1 FROM warehouse_reprint_jobs j WHERE (j.owner=${relatedOwners("NEW.owner")})
       AND j.state IN ('prepared','sending','delivery_unknown','failed_before_send'));
     SELECT RAISE(ABORT,'WAREHOUSE_TEMPLATES_REQUIRED') WHERE NOT EXISTS(
       SELECT 1 FROM warehouse_reprint_sessions s WHERE s.owner=NEW.owner AND s.session_id=NEW.session_id AND s.status='active'
         AND json_extract(s.session_json,'$.palletTemplate.id')=json_extract(NEW.rendering_json,'$.choice.id')
         AND json_extract(s.session_json,'$.palletTemplate.snapshotDigest')=json_extract(NEW.rendering_json,'$.choice.snapshotDigest')
         AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_session_closures c WHERE c.owner=s.owner AND c.session_id=s.session_id));
   END;`,
] as const;
