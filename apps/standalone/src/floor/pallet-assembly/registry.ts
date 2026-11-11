import { z } from "zod";

import type { BoxRegistryPage } from "../../host/pallet-assembly.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

const stateRow = z.object({
  until_at: z.string(),
  restore_epoch: z.string().nullable(),
  synced_at: z.string().nullable(),
  can_open_pallets: z.union([z.literal(0), z.literal(1)]).nullable(),
});

export async function readPalletRegistryState(local: LocalExecutor, pairing: Pairing) {
  const [row] = await local.query(
    "SELECT until_at, restore_epoch, synced_at, can_open_pallets FROM pallet_registry_state " +
      "WHERE host_id = ? AND device_id = ?",
    [pairing.hostId, pairing.deviceId],
    stateRow,
  );
  return row === undefined
    ? null
    : {
        until: row.until_at,
        restoreEpoch: row.restore_epoch,
        syncedAt: row.synced_at,
        canOpenPallets: row.can_open_pallets === null ? null : row.can_open_pallets === 1,
      };
}

/** Full refreshes are unusable before the last page. A partial delta can safely be replayed. */
export async function applyPalletRegistryPage(
  local: LocalExecutor,
  pairing: Pairing,
  page: BoxRegistryPage,
  options: { full: boolean; first: boolean; now?: Date; startedAt?: Date },
): Promise<void> {
  const owner = [pairing.hostId, pairing.deviceId];
  const now = (options.now ?? new Date()).toISOString();
  const statements: LocalStatement[] = [];
  if (options.full && options.first) {
    statements.push({
      sql: "DELETE FROM pallet_registry_boxes WHERE host_id = ? AND device_id = ?",
      values: owner,
    });
    statements.push({
      sql: "DELETE FROM pallet_registry_state WHERE host_id = ? AND device_id = ?",
      values: owner,
    });
  }
  statements.push({
    sql:
      "INSERT INTO pallet_registry_boxes (host_id, device_id, sscc, payload, refreshed_at) " +
      "SELECT ?, ?, value ->> 'sscc', value, ? FROM json_each(?) WHERE 1 " +
      "ON CONFLICT (host_id, device_id, sscc) DO UPDATE SET payload = excluded.payload, refreshed_at = excluded.refreshed_at",
    values: [...owner, options.startedAt?.toISOString() ?? now, JSON.stringify(page.items)],
  });
  if (page.nextCursor === undefined) {
    statements.push({
      sql:
        "INSERT INTO pallet_registry_state (host_id, device_id, until_at, restore_epoch, synced_at, can_open_pallets) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (host_id, device_id) DO UPDATE SET until_at = excluded.until_at, " +
        "restore_epoch = excluded.restore_epoch, synced_at = excluded.synced_at, can_open_pallets = excluded.can_open_pallets",
      values: [...owner, page.until, page.restoreEpoch ?? null, now, page.canOpenPallets ?? null],
    });
  }
  await local.transaction(statements);
}
