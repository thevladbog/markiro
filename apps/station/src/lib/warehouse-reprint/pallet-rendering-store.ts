import { palletRenderingV2Schema, type PalletRenderingV2 } from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
export async function savePalletRendering(
  exec: SqlExecutor,
  owner: string,
  jobId: string,
  value: PalletRenderingV2,
): Promise<void> {
  const rendering = palletRenderingV2Schema.parse(value);
  await exec.run(
    `INSERT INTO warehouse_pallet_renderings(owner,job_id,revision,value_json) VALUES(?,?,?,?)
     ON CONFLICT(owner,job_id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json`,
    [owner, jobId, rendering.renderingRevision, JSON.stringify(rendering)],
  );
}
export async function readPalletRendering(
  exec: SqlExecutor,
  owner: string,
  jobId: string,
): Promise<PalletRenderingV2 | null> {
  const [row] = await exec.all<{ value_json: string; revision: string }>(
    `SELECT value_json,revision FROM warehouse_pallet_renderings WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND job_id=? ORDER BY rowid ASC LIMIT 1`,
    [owner, jobId],
  );
  if (!row) return null;
  const value = palletRenderingV2Schema.parse(JSON.parse(row.value_json));
  if (value.renderingRevision !== row.revision) throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return value;
}
