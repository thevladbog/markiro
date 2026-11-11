import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

export interface PalletAssemblyContext {
  local: LocalExecutor;
  pairing: Pairing;
  operatorId: string;
  now?: () => Date;
  newId?: () => string;
}

export const ASSEMBLY_OPERATOR =
  "EXISTS (SELECT 1 FROM ref_operators WHERE id = ?) " +
  "AND (SELECT value FROM sync_state WHERE key = 'host_id') = ? " +
  "AND (SELECT value FROM sync_state WHERE key = 'device_id') = ?";

export function assemblyEvent(
  pairing: Pairing,
  operatorId: string,
  id: string,
  palletId: string,
  kind: string,
  at: string,
  data: Readonly<Record<string, unknown>>,
  boxSscc: string | null = null,
): LocalStatement {
  return {
    sql:
      "INSERT INTO pallet_assembly_outbox (id, host_id, device_id, pallet_id, kind, box_sscc, payload, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    values: [
      id,
      pairing.hostId,
      pairing.deviceId,
      palletId,
      kind,
      boxSscc,
      JSON.stringify({ id, kind, operatorId, data }),
      at,
    ],
    expectedChanges: 1,
  };
}

export async function applyAssemblyChange(
  local: LocalExecutor,
  statements: LocalStatement[],
): Promise<boolean> {
  try {
    await local.transaction(statements);
    return true;
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return false;
    throw error;
  }
}
