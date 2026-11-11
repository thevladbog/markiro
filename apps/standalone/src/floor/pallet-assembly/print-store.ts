import type { PalletAssemblyStore } from "./contracts.js";
import {
  applyAssemblyChange,
  ASSEMBLY_OPERATOR,
  assemblyEvent,
  type PalletAssemblyContext,
} from "./statements.js";

export function createAssemblyPrintStore(
  context: Required<PalletAssemblyContext>,
): Pick<
  PalletAssemblyStore,
  "startPrint" | "finishPrint" | "confirmPrint" | "deferPrint" | "recoverPrints"
> {
  const { local, pairing, operatorId, now, newId } = context;
  const owner = [pairing.hostId, pairing.deviceId];
  const actor = [operatorId, ...owner];
  const key = "id = ? AND host_id = ? AND device_id = ?";
  const at = () => now().toISOString();

  return {
    async startPrint(palletId, expectedLabelVersion, allowUnknown = false) {
      return applyAssemblyChange(local, [
        {
          sql:
            "INSERT INTO pallet_assembly_print_attempts (host_id, device_id, pallet_id, attempt, operator_id, started_at, retry_reason) " +
            "SELECT host_id, device_id, id, attempts + 1, ?, ?, CASE print_state WHEN 'unknown' THEN 'unknown_outcome' " +
            "WHEN 'sent' THEN 'label_missing' WHEN 'failed' THEN 'previous_failed' ELSE " +
            "CASE WHEN accepted_label IS NOT NULL THEN 'approved_correction' ELSE NULL END END " +
            `FROM pallet_assembly_pallets WHERE ${key} AND closed_at IS NOT NULL AND cancelled_at IS NULL AND ${ASSEMBLY_OPERATOR} ` +
            "AND NOT EXISTS (SELECT 1 FROM pallet_assembly_outbox o WHERE o.pallet_id = pallet_assembly_pallets.id " +
            "AND (o.outcome = 'rejected' OR o.replay_blocked = 1) AND o.resolved_at IS NULL " +
            "AND o.kind IN ('warehouse_pallet_opened', 'warehouse_pallet_closed')) " +
            "AND (coalesce(accepted_label, label) ->> 'boxCount') = (SELECT count(*) FROM pallet_assembly_members m " +
            "JOIN pallet_assembly_outbox o ON o.id = m.add_id WHERE m.pallet_id = pallet_assembly_pallets.id " +
            "AND m.removed_at IS NULL AND o.outcome IS NOT 'rejected' AND (accepted_members IS NULL " +
            "OR m.sscc IN (SELECT value FROM json_each(accepted_members)))) " +
            "AND label_version = ? " +
            "AND (print_state IN ('pending', 'failed') OR (? = 1 AND print_state IN ('unknown', 'sent')))",
          values: [
            operatorId,
            at(),
            palletId,
            ...owner,
            ...actor,
            expectedLabelVersion,
            allowUnknown,
          ],
          expectedChanges: 1,
        },
        {
          sql:
            "UPDATE pallet_assembly_pallets SET print_state = 'printing', attempts = attempts + 1, " +
            `print_reason = NULL, deferred = 0 WHERE ${key}`,
          values: [palletId, ...owner],
          expectedChanges: 1,
        },
      ]);
    },
    async finishPrint(palletId, state, reason) {
      return applyAssemblyChange(local, [
        {
          sql:
            "UPDATE pallet_assembly_pallets SET print_state = ?, print_reason = ? " +
            `WHERE ${key} AND print_state = 'printing'`,
          values: [state, reason ?? null, palletId, ...owner],
          expectedChanges: 1,
        },
        {
          sql:
            "UPDATE pallet_assembly_print_attempts SET finished_at = ?, outcome = ?, reason = ? " +
            "WHERE pallet_id = ? AND host_id = ? AND device_id = ? AND finished_at IS NULL",
          values: [at(), state, reason ?? null, palletId, ...owner],
          expectedChanges: 1,
        },
      ]);
    },
    async confirmPrint(palletId, expectedLabelVersion, verified = false) {
      const time = at();
      return applyAssemblyChange(local, [
        {
          sql:
            "UPDATE pallet_assembly_pallets SET print_state = 'confirmed', print_reason = NULL, deferred = 0 " +
            `WHERE ${key} AND cancelled_at IS NULL AND print_state IN ('sent', 'unknown') AND ${ASSEMBLY_OPERATOR} ` +
            "AND label_version = ? AND (? = 0 OR label_version = 0)",
          values: [palletId, ...owner, ...actor, expectedLabelVersion, verified],
          expectedChanges: 1,
        },
        assemblyEvent(pairing, operatorId, newId(), palletId, "warehouse_pallet_label", time, {
          palletId,
          outcome: verified ? "verified" : "skipped",
          at: time,
        }),
      ]);
    },
    async deferPrint(palletId) {
      return applyAssemblyChange(local, [
        {
          sql:
            `UPDATE pallet_assembly_pallets SET deferred = 1 WHERE ${key} AND closed_at IS NOT NULL AND cancelled_at IS NULL ` +
            `AND print_state NOT IN ('printing', 'confirmed') AND ${ASSEMBLY_OPERATOR}`,
          values: [palletId, ...owner, ...actor],
          expectedChanges: 1,
        },
      ]);
    },
    async recoverPrints(inFlightIds) {
      const inFlight = JSON.stringify(inFlightIds);
      await local.transaction([
        {
          sql:
            "UPDATE pallet_assembly_print_attempts SET finished_at = ?, outcome = 'unknown', reason = 'interrupted' " +
            "WHERE host_id = ? AND device_id = ? AND finished_at IS NULL " +
            "AND pallet_id NOT IN (SELECT value FROM json_each(?))",
          values: [at(), ...owner, inFlight],
        },
        {
          sql:
            "UPDATE pallet_assembly_pallets SET print_state = 'unknown', print_reason = 'interrupted' " +
            "WHERE host_id = ? AND device_id = ? AND print_state = 'printing' AND id NOT IN (SELECT value FROM json_each(?))",
          values: [...owner, inFlight],
        },
      ]);
    },
  };
}
