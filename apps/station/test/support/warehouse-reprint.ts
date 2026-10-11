import type { SqlExecutor } from "../../src/lib/mirror.js";
import { warehouseBoxSource, warehouseBoxTemplate, warehousePreparedEvent } from "@markiro/domain";
import type { WarehousePreparedJobInput } from "../../src/lib/warehouse-reprint/types.js";
export function warehousePreparedJobInput(): WarehousePreparedJobInput {
  const event = warehousePreparedEvent();
  return {
    owner: "owner",
    sessionId: event.sessionId,
    jobId: event.jobId,
    deviceId: "00000000-0000-4000-8000-000000000030",
    operatorId: event.operatorId,
    reason: "damaged",
    source: warehouseBoxSource(),
    template: warehouseBoxTemplate(),
    printer: {
      id: "tsc",
      name: "TSC 210",
      target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
      language: "tspl",
      dpi: 203,
    },
    fields: warehouseBoxSource().fields,
    bytesBase64: btoa("print"),
    bytesDigest: event.bytesDigest,
    preparedEvent: event,
  };
}

export async function seedWarehouseOperator(exec: SqlExecutor, operatorId: string): Promise<void> {
  const [slot] = await exec.all<{ value: string }>(
    "SELECT value FROM station_meta WHERE key='operators_slot'",
  );
  const table = slot?.value === "b" ? "operators_mirror_b" : "operators_mirror";
  await exec.run(
    `INSERT INTO ${table}(operator_id,name,role,pin_hash,active) VALUES(?,'Sample Operator','operator','synthetic-verifier',1) ON CONFLICT(operator_id) DO UPDATE SET active=1`,
    [operatorId],
  );
  // Recovery fixtures seed a usable current roster, as a successful roster refresh does.
  await exec.run("UPDATE station_meta SET value='0' WHERE key='operators_blocked'");
}
