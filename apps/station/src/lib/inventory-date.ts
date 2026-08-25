import type { SqlExecutor } from "./mirror.js";

export interface InventoryTerminalScope {
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
}

export interface SetInventoryProductionDateInput extends InventoryTerminalScope {
  operatorId: string;
  productionDate: string;
  updatedAt: string;
}

const CIVIL_DATE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function assertCivilDate(value: string): void {
  if (!CIVIL_DATE.test(value)) throw new Error("inventory production date is invalid");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("inventory production date is invalid");
  }
}

export async function loadInventoryProductionDate(
  exec: SqlExecutor,
  scope: InventoryTerminalScope,
): Promise<string | null> {
  const rows = await exec.all<{ active_production_date: string | null }>(
    `SELECT active_production_date
       FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    [scope.inventoryId, scope.snapshotId, scope.deviceId],
  );
  return rows[0]?.active_production_date ?? null;
}

/** Persists the terminal-local date. Existing event/result rows are deliberately untouched. */
export async function setInventoryProductionDate(
  exec: SqlExecutor,
  input: SetInventoryProductionDateInput,
): Promise<void> {
  assertCivilDate(input.productionDate);
  await exec.run(
    `INSERT INTO inventory_terminal_state
       (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
        next_device_sequence, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(inventory_id, snapshot_id, device_id) DO UPDATE SET
       operator_id = excluded.operator_id,
       active_production_date = excluded.active_production_date,
       updated_at = excluded.updated_at`,
    [
      input.inventoryId,
      input.snapshotId,
      input.deviceId,
      input.operatorId,
      input.productionDate,
      input.updatedAt,
    ],
  );
}
