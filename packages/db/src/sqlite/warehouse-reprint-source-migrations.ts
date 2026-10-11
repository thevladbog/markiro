/** Append-only upgrade: old mixed cache rows are preserved, never blindly granted local provenance. */
export const WAREHOUSE_REPRINT_SOURCE_MIGRATIONS = [
  `ALTER TABLE warehouse_reprint_cache ADD COLUMN cached_at TEXT NOT NULL DEFAULT '';`,
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_local_boxes (
    owner TEXT NOT NULL, identity TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK(json_valid(value_json)),
    eligibility_denied INTEGER NOT NULL DEFAULT 0 CHECK(eligibility_denied IN (0,1)),
    PRIMARY KEY(owner,identity));`,
  // Recover only a complete box snapshot corroborated by an actual local closure.
  // A legacy server refresh may already have replaced fields; unavailable originals cannot be reconstructed.
  `INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json)
    SELECT c.owner,c.identity,c.value_json FROM warehouse_reprint_cache c
    WHERE c.kind='box' AND c.cached_at=''
      AND json_extract(c.value_json,'$.kind')='box'
      AND json_extract(c.value_json,'$.identity')=c.identity
      AND json_extract(c.value_json,'$.fields.sscc')=c.identity
      AND json_extract(c.value_json,'$.unavailableFields')='[]'
      AND json_type(c.value_json,'$.fields')='object'
      AND (SELECT count(*) FROM json_each(c.value_json,'$.fields'))=13
      AND NOT EXISTS(SELECT 1 FROM json_each(c.value_json,'$.fields') WHERE type<>'text')
      AND length(json_extract(c.value_json,'$.revision'))=64
      AND length(json_extract(c.value_json,'$.payloadDigest'))=64
      AND (EXISTS(SELECT 1 FROM boxes_mirror b
        WHERE b.box_id=json_extract(c.value_json,'$.sourceId') AND b.sscc=c.identity
          AND b.shift_id=json_extract(c.value_json,'$.sourceShiftId') AND b.closed_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM inventory_repack_boxes_mirror b
        WHERE b.box_id=json_extract(c.value_json,'$.sourceId') AND b.new_sscc=c.identity
          AND b.closed_at IS NOT NULL))
    ON CONFLICT(owner,identity) DO NOTHING;`,
];
