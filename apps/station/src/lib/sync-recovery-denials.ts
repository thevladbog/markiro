import type { SqlExecutor } from "./mirror.js";

/** Preserve quarantine guards before replacing the last-batch diagnostic snapshot. */
export async function retainRecoveryDeniedShifts(exec: SqlExecutor, shiftIds: string[]) {
  await exec.run(
    `INSERT OR IGNORE INTO station_meta(key,value)
     SELECT 'sync_recovery_denied_shift:'||shift_id,'1' FROM (
       SELECT value shift_id FROM json_each(?) WHERE type='text'
       UNION
       SELECT json_extract(q.value,'$.shiftId') shift_id
       FROM station_meta m,json_each(CASE WHEN json_valid(m.value) THEN m.value ELSE '{}' END,'$.denied') q
       WHERE m.key='sync_last_recovery_denied' AND q.type='object'
     ) WHERE shift_id IS NOT NULL`,
    [JSON.stringify(shiftIds)],
  );
}
